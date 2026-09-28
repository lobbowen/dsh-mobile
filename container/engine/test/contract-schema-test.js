'use strict';
// 契约 schema 校验：docs/contracts/*.schema.json 必须存在、可解析，且引擎产出的对象符合它。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const runtimeContract = require('../src/runtime-json');
const { buildKernelJson } = require('../src/program-bundle');

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
  } else if (t === 'integer' || t === 'number') {
    if (typeof obj !== 'number' || (t === 'integer' && !Number.isInteger(obj))) return [p + ' 应为 ' + t];
    if (typeof schema.minimum === 'number' && obj < schema.minimum) errs.push(p + ' < minimum ' + schema.minimum);
    if (typeof schema.maximum === 'number' && obj > schema.maximum) errs.push(p + ' > maximum ' + schema.maximum);
  } else if (t === 'boolean') {
    if (typeof obj !== 'boolean') return [p + ' 应为 boolean'];
  }
  return errs;
}

const rSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/runtime-json.schema.json'), 'utf8'));
const kSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/program-manifest.schema.json'), 'utf8'));
check('runtime-json.schema.json 可解析', !!rSchema);
check('program-manifest.schema.json 可解析', !!kSchema);
check('runtime schema.const 与引擎 SCHEMA 常量一致',
  rSchema.properties.schema.const === runtimeContract.SCHEMA,
  'schema=' + rSchema.properties.schema.const + ' engine=' + runtimeContract.SCHEMA);

const sample = {
  schema: runtimeContract.SCHEMA, nodePath: '/d/libnode.so', nodeBinDir: '/d',
  npmPath: '/d/libnode.so', minNode: 'v24.12.0', writtenBy: 'lobos-os',
};
const se = validate(sample, rSchema, 'runtime');
check('runtime 样本符合 schema', se.length === 0, se.join('; '));

const kj = buildKernelJson({ version: '1.2.3' });
kj.signature = 'sig';
const ke = validate(kj, kSchema, 'program');
check('program-manifest 样本符合 schema', ke.length === 0, ke.join('; '));

// 反向自证：schema 里 requiresProtocol 是 integer+minimum，校验器必须真的判它，
// 否则「类型/下界」这一格是空转（历史上本校验器只认 object/array/string）。
{
  const badType = buildKernelJson({ version: '1.2.3' });
  badType.requiresProtocol = '1';            // 字符串 → 必须被抓
  badType.signature = 'sig';
  const e1 = validate(badType, kSchema, 'program');
  check('反向：requiresProtocol 类型错（字符串）会被抓', e1.length > 0, e1.join('; '));

  const badMin = buildKernelJson({ version: '1.2.3' });
  badMin.requiresProtocol = -1;              // 低于 minimum 0 → 必须被抓
  badMin.signature = 'sig';
  const e2 = validate(badMin, kSchema, 'program');
  check('反向：requiresProtocol 低于 minimum 会被抓', e2.length > 0, e2.join('; '));
}

// 源清单的 requires 必须全是已知组令牌（授权表事实源，复检 AUD-G35）
const KNOWN_GROUPS = ['base', 'app_control', 'ui_automation', 'shell', 'storage', 'build', 'notification', 'system'];
for (const d of fs.readdirSync(path.join(ROOT, 'programs'))) {
  const mf = path.join(ROOT, 'programs', d, 'manifest.json');
  if (!fs.existsSync(mf)) continue;
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { doc = null; }
  const bad = (doc && Array.isArray(doc.requires) ? doc.requires : [])
    .map((r) => String(r).replace('bridge:', ''))
    .filter((g) => !KNOWN_GROUPS.includes(g));
  check('源清单 ' + d + ' 的 requires 全是已知组令牌', bad.length === 0, bad.join(','));
}

// 源清单（programs/*/manifest.json）必须符合 program-source.schema.json 的核心契约（复检 AUD-G29）
const SRC_DIR = path.join(ROOT, 'programs');
const srcSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/program-source.schema.json'), 'utf8'));
for (const d of fs.readdirSync(SRC_DIR)) {
  const mf = path.join(SRC_DIR, d, 'manifest.json');
  if (!fs.existsSync(mf)) continue;
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { doc = null; }
  const missing = (srcSchema.required || []).filter((k) => !doc || doc[k] === undefined);
  check('源清单 ' + d + ' 合法且字段齐', doc !== null && missing.length === 0, missing.length ? 'missing=' + missing.join(',') : '');
}
console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
