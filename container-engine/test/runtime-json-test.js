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
  minNode: 'v24.12.0',
});

check('schema = 2（对齐内核 SUPPORTED_SCHEMA）', obj.schema === 2 && SCHEMA === 2);
check('含 nodePath', obj.nodePath === '/data/app/node/24.21.0/node');
check('含 nodeBinDir', obj.nodeBinDir === '/data/app/node/24.21.0');
check('含 npmPath', obj.npmPath === '/data/app/node/24.21.0/npm');
// npmEntry = npm-cli.js 绝对路径（schema 2 新增可选键，内核据此 node 代跑 npm）。
check('含 npmEntry', obj.npmEntry === '/data/app/node/24.21.0/npm-cli.js');
check('含 minNode', obj.minNode === 'v24.12.0');
check('含 writtenBy', obj.writtenBy === 'android-node-container');

const read = readRuntimeJson(home);
check('读回 object 与写入一致', read && read.schema === 2 && read.nodePath === obj.nodePath && read.npmEntry === obj.npmEntry);

// 未投放 npm（旧容器形态）时**省略** npmEntry 键而非写 null：内核按未知/缺失键降级。
const objNoEntry = writeRuntimeJson({ home, nodePath: '/x/node', nodeBinDir: '/x', npmPath: '/x/npm' });
check('缺省 npmEntry 时不写该键', !('npmEntry' in objNoEntry));

// schema 不符抛错
const badPath = path.join(home, 'supervisor', 'runtime.json');
fs.writeFileSync(badPath, JSON.stringify({ schema: 99, nodePath: 'x' }));
let threw = false;
try { readRuntimeJson(home); } catch (_e) { threw = true; }
check('schema 不符时抛出', threw === true);

finish();
