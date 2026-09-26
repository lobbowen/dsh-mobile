'use strict';

// runtime.json：容器写入、内核读取；schema 必须为 2 且与内核契约字段一致。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeRuntimeJson, readRuntimeJson, SCHEMA } = require('../src/runtime-json');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('runtime-json');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
const obj = writeRuntimeJson({
  home,
  nodePath: '/data/app/node/24.21.0/node',
  nodeBinDir: '/data/app/node/24.21.0',
  npmPath: '/data/app/node/24.21.0/npm',
  npmEntry: '/data/app/node/24.21.0/npm-cli.js',
  prefix: '/data/user/0/x/files/usr',
  minNode: 'v24.12.0',
});

check('schema = 2（对齐内核 SUPPORTED_SCHEMA）', obj.schema === 2 && SCHEMA === 2);
check('含 nodePath', obj.nodePath === '/data/app/node/24.21.0/node');
check('含 nodeBinDir', obj.nodeBinDir === '/data/app/node/24.21.0');
check('含 npmPath', obj.npmPath === '/data/app/node/24.21.0/npm');
// npmEntry = npm-cli.js 绝对路径（schema 2 新增可选键，内核据此 node 代跑 npm）。
check('含 npmEntry', obj.npmEntry === '/data/app/node/24.21.0/npm-cli.js');
// prefix = $PREFIX 根（内核投放单元的唯一取件路径）。
check('含 prefix', obj.prefix === '/data/user/0/x/files/usr');
check('含 minNode', obj.minNode === 'v24.12.0');
check('含 writtenBy', obj.writtenBy === 'android-node-container');

const read = readRuntimeJson(home);
check('读回 object 与写入一致', read && read.schema === 2 && read.nodePath === obj.nodePath && read.npmEntry === obj.npmEntry);

// 未投放 npm / 旧容器无 $PREFIX（可选键）时**省略**该键而非写 null：内核按缺失键降级。
const objNoEntry = writeRuntimeJson({ home, nodePath: '/x/node', nodeBinDir: '/x', npmPath: '/x/npm' });
check('缺省 npmEntry 时不写该键', !('npmEntry' in objNoEntry));
check('缺省 prefix 时不写该键', !('prefix' in objNoEntry));

// schema 不符抛错
const badPath = path.join(home, 'supervisor', 'runtime.json');
fs.writeFileSync(badPath, JSON.stringify({ schema: 99, nodePath: 'x' }));
let threw = false;
try { readRuntimeJson(home); } catch (_e) { threw = true; }
check('schema 不符时抛出', threw === true);

// ── 跨语言对账：生产写方（Kotlin :node 服务）与测试夹具写方（本 JS 模块）必须写同一套键。
// 为什么需要：runtime.json 是**容器写、内核读**的唯一通道，两份写实现漂移的后果是
// 「夹具测得过、真机上内核读不到 prefix ⇒ 投放单元全部判 blocked」—— 正是 2026-09-26
// 那次 glob/grep 全灭的形状（那时连门控键都没写，谁都看不见）。
// 取**区间切片**而非整文件计数：NodeRuntimeService 里还有别的 JSONObject.put，整文件计数
// 会把不相干的键算进契约里，那样"对上了"是假的。
const ktSrc = path.join(__dirname, '..', '..', '..',
  'container/app/src/main/java/io/github/lobbowen/dshmobile/runtime/NodeRuntimeService.kt');
const kt = fs.readFileSync(ktSrc, 'utf8');
const fnHead = kt.indexOf('private fun writeRuntimeJson');
const fnTail = kt.indexOf('File(dir, "runtime.json")', fnHead);
check('定位到 Kotlin 侧 writeRuntimeJson 的落盘区间', fnHead >= 0 && fnTail > fnHead, 'head=' + fnHead + ' tail=' + fnTail);
const ktKeys = [...kt.slice(fnHead, fnTail).matchAll(/\bput\(\s*"([A-Za-z][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
check('Kotlin 侧解析出自证（键数不少于本契约字段数）', ktKeys.length >= Object.keys(obj).length, 'kt=' + ktKeys.join(','));
const onlyKt = ktKeys.filter((k) => !(k in obj));
const onlyJs = Object.keys(obj).filter((k) => !ktKeys.includes(k));
check('两份写实现键集相等（双向比对）', onlyKt.length === 0 && onlyJs.length === 0,
  '只在 Kotlin=' + onlyKt.join(',') + ' 只在 JS=' + onlyJs.join(','));

finish();
