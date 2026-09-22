'use strict';

// ★ 文件/目录访问保护 —— Android-only（POSIX 语义）★
//
// 产品大量使用 `fs.writeFileSync(f, data, { mode: 0o600 })` 保护敏感文件
// （config.json 含 lanToken、registry.json、state.json 等）。
// 安卓（Linux 内核）下 POSIX mode 有效：文件 0600 / 目录 0700。
//
// 工业级要点：**保护目录一次**即可让后续新建文件继承约束（比逐文件 chmod 快且不漏）；
// 逐文件保护用于「目录已存在、文件为历史遗留」的场景。全部 best-effort：失败不阻断主流程，
// 但结果可观测（返回值）。
//
// ⚠ 已删除的 PC 遗留（勿回潮）：Windows `icacls /inheritance:r /grant:r`（NTFS ACL）——
//   安卓没有 NTFS/ACL 语义，也不存在该二进制。

const fs = require('node:fs');
const path = require('node:path');

/** 保护单个文件（chmod 0600）。
 *  @returns {{ok:boolean, mode:string, reason?:string}} */
function protectFile(file) {
  try { fs.chmodSync(file, 0o600); return { ok: true, mode: 'posix-0600' }; }
  catch (e) { return { ok: false, mode: 'posix-0600', reason: e.message }; }
}

/** 保护目录（chmod 0700）。建议在数据目录创建后调用一次——内部新建文件自动继承约束。
 *  @returns {{ok:boolean, mode:string, reason?:string}} */
function protectDir(dir) {
  try { fs.chmodSync(dir, 0o700); return { ok: true, mode: 'posix-0700' }; }
  catch (e) { return { ok: false, mode: 'posix-0700', reason: e.message }; }
}

/** 确保目录存在并施加保护（创建 + 保护一步到位）。 */
function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, mode: 'mkdir', reason: e.message }; }
  return protectDir(dir);
}

/** 写入敏感文件并施加保护（原子写 + 保护；避免「写完到保护之间」的可读窗口）。
 *
 *  ⚠ **保护失败必须如实返回 `ok:false`**（P2-1 修复精神）：此前实现无条件 `return {ok:true}`，
 *     把「icacls/权限收紧失败」当成成功上报 —— 本仓禁忌「catch 后当成功」。
 *
 *  @param {string} file 目标文件（自动创建父目录）
 *  @param {string|Buffer} data
 *  @returns {{ok:boolean, reason?:string, mode?:string}} */
function writePrivate(file, data) {
  try {
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const tmp = file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    const p1 = protectFile(tmp);
    if (p1 && p1.ok === false) { try { fs.rmSync(tmp, { force: true }); } catch {} return { ok: false, reason: 'protect(tmp): ' + (p1.reason || p1.mode), mode: p1.mode }; }
    fs.renameSync(tmp, file);
    const p2 = protectFile(file); // rename 后再次确保（部分文件系统 rename 不保留 mode）
    if (p2 && p2.ok === false) return { ok: false, reason: 'protect(file): ' + (p2.reason || p2.mode), mode: p2.mode };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { protectFile, protectDir, ensurePrivateDir, writePrivate };
