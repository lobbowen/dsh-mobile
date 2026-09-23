#!/usr/bin/env node
'use strict';

// ============================================================================
// 跨语言一致性：Kotlin(KernelVersions) 与 JS(kernel-version.js) 必须对同一份
// 用例表给出**相同的符号**。
// ============================================================================
// 为什么必须有：这套比较逻辑有两份实现，注释里写着「必须逐 token 等价」，
// 但此前**只靠人眼**保证。一旦分叉，后果是静默的 ——
//   要么设备判不出更新（永远停在旧版），要么把旧版判成新版。
//
// 用例表 container/app/src/test/resources/kernel-version-cases.txt 由**两侧共读**：
//   Kotlin 侧 = KernelVersionsTest；JS 侧 = 本文件。
// 哪一侧漂移，哪一侧就变红 —— 这是把「两份实现必须等价」从注释变成门禁。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { compare } = require('../src/kernel-version');

const FILE = path.join(__dirname, '..', '..', 'app', 'src', 'test', 'resources', 'kernel-version-cases.txt');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  \u2190 ' + detail : '')); }
}

if (!fs.existsSync(FILE)) {
  console.log('FAIL 共享用例表缺失: ' + FILE);
  console.log('结果: 0 passed, 1 failed');
  process.exit(1);
}

const lines = fs.readFileSync(FILE, 'utf8').split('\n')
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith('#'));

check('共享用例表非空且覆盖足够', lines.length >= 15, 'lines=' + lines.length);

for (const line of lines) {
  const [a, b, expStr] = line.split('|');
  const expected = Number(expStr);
  const got = Math.sign(compare(a, b));
  check('compare(' + JSON.stringify(a) + ', ' + JSON.stringify(b) + ') == ' + expected, got === expected, '得到 ' + got);
}

for (const line of lines) {
  const [a, b, expStr] = line.split('|');
  const expected = Number(expStr);
  if (expected === 0) continue;
  const rev = Math.sign(compare(b, a));
  check('反对称 compare(' + JSON.stringify(b) + ', ' + JSON.stringify(a) + ') == ' + (-expected), rev === -expected, '得到 ' + rev);
}

// 与 OtaPolicy 的分桶一致性无关，但顺带钉住一个语义：未安装时 isNewer 恒为真。
const { isNewer } = require('../src/kernel-version');
check('isNewer(x, null) 为真（尚未安装 → 需要安装）', isNewer('0.1.0', null) === true);
check('isNewer(相等) 为假', isNewer('1.0.0', '1.0.0') === false);

console.log('结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
