'use strict';

// 平台进程控制：组信号 / 树杀 / 存活探测 —— Android-only（POSIX/Linux 语义）。
//
// 安卓内核跑在容器里（process.platform === 'linux'）：
// · 进程组信号可用（spawn 时 detached → 自成组），故 `kill(-pid)` 即"树杀"；
// · 无 Windows 进程树语义，也就不需要 taskkill。
//
// 已删除的 PC 遗留（勿回潮）：`taskkill /PID <pid> /T`（Windows 整树终止）。
// 能力矩阵的 processTreeKill 仍为 false —— 安卓容器里的"整树"= 进程组 SIGTERM，
// 不做跨组孙进程遍历（容器回收进程组已足够）。

/** kill(pid,0) 存活探测。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }
}

/** 向进程（组）发信号：先组信号（-pid），失败退单进程。 */
function signalProcess(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}

/** 整树终止（尽力而为，回调式）：进程组 SIGTERM（或指定信号）。 */
function killTree(pid, sig, cb) {
  if (!Number.isInteger(pid) || pid <= 0) { if (cb) cb(new Error('invalid pid')); return; }
  signalProcess(pid, sig || 'SIGTERM');
  if (cb) process.nextTick(cb, null);
}

module.exports = { isAlive, signalProcess, killTree };
