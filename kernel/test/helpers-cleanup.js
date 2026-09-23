'use strict';
// 测试自清理：detached 子进程（dry-run/mock 实例）在测试进程退出时不会自动终结——
// 统一在 exit 钩子里强杀仍存活的测试实例 pid（防 4100x 端口段被积压占用导致间歇性失败）。
module.exports = function registerCleanup(listProviders) {
  process.on('exit', () => {
    try {
      const providers = typeof listProviders === 'function' ? listProviders() : [];
      for (const p of providers || []) {
        for (const i of (p.instances || [])) {
          if (i.pid) { try { process.kill(i.pid, 'SIGKILL'); } catch {} i.pid = null; }
        }
      }
    } catch {}
  });
};
