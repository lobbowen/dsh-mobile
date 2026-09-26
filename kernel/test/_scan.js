'use strict';

const fs = require('node:fs');
const path = require('node:path');

// kernel 测试的共享源码扫描工具（**唯一实现**，门禁法①/③）。
// 字符串感知的注释剥离 + 括号配对的调用提取，供扫描式门禁复用。
// （历史：这两段曾内嵌在 exec-bounded-gate-test.js 里。）

/** 剥离注释（行注释 + 块注释），保留换行以维持行号。 */
function stripComments(src) {
  // 逐字符扫描：正确跳过字符串字面量内的 // 与 /* */
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < src.length) {
    const c = src[i];
    const n2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; } else { out += ' '; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n') ? c : ' ';
      i++; continue;
    }
    // 字符串内部：原样保留（但换行在单/双引号里非法，模板里合法）
    if (state === 'sq' || state === 'dq' || state === 'tpl') {
      if (c === '\\') { out += c + (n2 || ''); i += 2; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
        state = 'code';
      }
      out += c; i++; continue;
    }
  }
  return out;
}

/** 括号配对提取每个 `execFileSync(` / `spawnSync(` 的完整调用表达式。 */
function calls(src, fnNames) {
  const out = [];
  for (const fn of fnNames) {
    const re = new RegExp('\\b' + fn + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        i++;
      }
      out.push({ at: m.index, text: src.slice(m.index, i), fn });
    }
  }
  return out;
}

const readFile = (f) => fs.readFileSync(f, 'utf8');

/** 收集产品代码文件：<root>/src 下全部 .js + <root>/bin 下入口（bin 脚本无 .js 后缀）。 */
function productFiles(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.js')) out.push(p);
    }
  })(path.join(root, 'src'));
  const binDir = path.join(root, 'bin');
  if (fs.existsSync(binDir)) {
    for (const e of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (e.isFile()) out.push(path.join(binDir, e.name));
    }
  }
  return out;
}

/** 除 exemptRel 外，出现 fnNames 调用的违规点（'相对路径:行 函数名'）。 */
function bannedCalls(root, fnNames, exemptRel) {
  const out = [];
  for (const f of productFiles(root)) {
    const rel = path.relative(root, f);
    if (rel === exemptRel) continue;
    const code = stripComments(readFile(f));
    for (const c of calls(code, fnNames)) {
      const line = code.slice(0, c.at).split(String.fromCharCode(10)).length;
      out.push(rel + ':' + line + ' ' + c.fn);
    }
  }
  return out;
}

/** 引用了匹配 re 的模块的源文件（相对路径）。注意 re **不要**带 /g（避免 lastIndex 残留）。 */
function filesRequiring(root, re, exemptRel) {
  const out = [];
  for (const f of productFiles(root)) {
    const rel = path.relative(root, f);
    if (rel === exemptRel) continue;
    if (re.test(stripComments(readFile(f)))) out.push(rel);
  }
  return out;
}

module.exports = { stripComments, calls, productFiles, bannedCalls, filesRequiring };
