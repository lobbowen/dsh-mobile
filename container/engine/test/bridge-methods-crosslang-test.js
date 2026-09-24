'use strict';
// 桥方法表跨语言同步门禁（Kotlin HostBridgeService ⇄ engine methods.js）
//
// 修复的缺陷（历史 B 类）：两张方法表过去只靠注释互指「与 Kotlin 对齐」——
// 对齐与否没有任何机器判定，漂移只在真机 -32001 时才暴露。本门禁把注释
// 升级为断言：方法名集合、每方法 caps、audit 标志、组代表能力，逐项比对。
//
// 能红的证明：把 methods.js 里任一 caps 改一个词、或给 Kotlin 加一个方法而
// 不加 JS —— 对应断言立刻 FAIL。这不是过滤后恒真的检查。

const fs = require('fs');
const path = require('path');
const makeRunner = require('./harness');
const { check, finish } = makeRunner('bridge-methods-crosslang');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const KOTLIN = path.join(ROOT, 'container', 'app', 'src', 'main', 'java', 'io', 'github',
  'lobbowen', 'dshmobile', 'bridge', 'HostBridgeService.kt');
const methods = require('../src/bridge/methods');

const ksrc = fs.readFileSync(KOTLIN, 'utf8');

// ── 解析 Kotlin 方法表：`"a.b" to MethodDef(listOf("cap1", "cap2"), audit) {` ──
const kotlin = new Map();
const re = /"([a-z][\w]*\.[\w]+)"\s+to\s+MethodDef\(\s*listOf\(([^)]*)\)\s*,\s*(true|false)\s*\)/g;
let m;
while ((m = re.exec(ksrc)) !== null) {
  const caps = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  kotlin.set(m[1], { caps: caps.slice().sort(), audit: m[3] === 'true' });
}
check('Kotlin 方法表解析非空（≥15 个方法，防正则空转）', kotlin.size >= 15, 'size=' + kotlin.size);

const js = new Map();
for (const [name, def] of Object.entries(methods.METHODS)) {
  js.set(name, { caps: def.caps.slice().sort(), audit: !!def.audit });
}

// ── 集合相等 ──
const onlyKotlin = [...kotlin.keys()].filter((k) => !js.has(k));
const onlyJs = [...js.keys()].filter((k) => !kotlin.has(k));
check('方法名集合一致（Kotlin 无未登记方法）', onlyKotlin.length === 0, onlyKotlin.join(', '));
check('方法名集合一致（JS 无未实现方法）', onlyJs.length === 0, onlyJs.join(', '));

// ── 逐方法 caps / audit ──
const capDiff = [], auditDiff = [];
for (const [name, kd] of kotlin) {
  const jd = js.get(name);
  if (!jd) continue;
  if (kd.caps.join('|') !== jd.caps.join('|')) {
    capDiff.push(`${name}: kotlin=[${kd.caps}] js=[${jd.caps}]`);
  }
  if (kd.audit !== jd.audit) auditDiff.push(`${name}: kotlin=${kd.audit} js=${jd.audit}`);
}
check('每方法 caps 两表一致', capDiff.length === 0, capDiff.join('; '));
check('每方法 audit 两表一致', auditDiff.length === 0, auditDiff.join('; '));

// ── 组代表能力：Kotlin GROUP_REQUIRED("bridge:x" to "cap") ⇄ JS GROUP_REQUIRED(x: cap) ──
const kGroups = new Map();
const gre = /"(bridge:[a-z_]+)"\s+to\s+"([a-z_]+)"/g;
while ((m = gre.exec(ksrc)) !== null) kGroups.set(m[1].slice('bridge:'.length), m[2]);
check('Kotlin 组表解析出 8 组（防正则空转）', kGroups.size === 8, 'size=' + kGroups.size);
const grpDiff = [];
for (const [g, cap] of kGroups) {
  if (methods.GROUP_REQUIRED[g] !== cap) grpDiff.push(`${g}: kotlin=${cap} js=${methods.GROUP_REQUIRED[g]}`);
}
check('组代表能力两表一致', grpDiff.length === 0, grpDiff.join('; '));

// ── 本次迁移的核心不变量（单独钉死，语义比"两表一致"更强）──
check('shell.exec 门禁 = adb_shell（唯一特权 shell 通道）',
  JSON.stringify(methods.METHODS['shell.exec'].caps) === JSON.stringify(['adb_shell']));
check('shell.pair/status/forget 门禁 = base（未配对设备必须能发起配对）',
  ['shell.pair', 'shell.status', 'shell.forget'].every((k) => JSON.stringify(methods.METHODS[k].caps) === JSON.stringify(['base'])));
check('DEVICE_CAPS 含 adb_shell', methods.DEVICE_CAPS.includes('adb_shell'));

finish();
