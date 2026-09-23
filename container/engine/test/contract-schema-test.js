'use strict';
// 契约 schema 校验：docs/contracts/*.schema.json 必须存在、可解析，且引擎产出的对象符合它。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const runtimeContract = require('../src/runtime-json');
const { buildKernelJson } = require('../src/kernel-bundle');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}
function validate(obj, schema, p) {
  const errs = [];
  const t = schema.type;
  if ('const' in schema && obj !== schema.const) errs.push(p + ' 应恒为 ' + JSON.stringify(schema.const));
  if (t === 'object') {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return [p + ' 应为 object'];
    for (const r of schema.required || []) if (!(r in obj)) errs.push(p + '.' + r + ' 缺失');
    for (const [k, sv] of Object.entries(schema.properties || {})) if (k in obj) errs.push(...validate(obj[k], sv, p + '.' + k));
  } else if (t === 'array') {
    if (!Array.isArray(obj)) return [p + ' 应为 array'];
    if (schema.items) obj.forEach((v, i) => errs.push(...validate(v, schema.items, p + '[' + i + ']')));
  } else if (t === 'string') {
    if (typeof obj !== 'string') return [p + ' 应为 string'];
    if (schema.pattern && !new RegExp(schema.pattern).test(obj)) errs.push(p + ' 不匹配 ' + schema.pattern);
  }
  return errs;
}

const rSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/runtime-json.schema.json'), 'utf8'));
const kSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/kernel-bundle.schema.json'), 'utf8'));
check('runtime-json.schema.json 可解析', !!rSchema);
check('kernel-bundle.schema.json 可解析', !!kSchema);
check('runtime schema.const 与引擎 SCHEMA 常量一致',
  rSchema.properties.schema.const === runtimeContract.SCHEMA,
  'schema=' + rSchema.properties.schema.const + ' engine=' + runtimeContract.SCHEMA);

const sample = {
  schema: runtimeContract.SCHEMA, nodePath: '/d/libnode.so', nodeBinDir: '/d',
  npmPath: '/d/libnode.so', minNode: 'v24.12.0', writtenBy: 'android-node-container',
};
const se = validate(sample, rSchema, 'runtime');
check('runtime 样本符合 schema', se.length === 0, se.join('; '));

const kj = buildKernelJson({ version: '1.2.3' });
kj.signature = 'sig';
const ke = validate(kj, kSchema, 'kernel');
check('kernel.json 样本符合 schema', ke.length === 0, ke.join('; '));

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
