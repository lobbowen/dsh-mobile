'use strict';

// 域：统一安装/更新任务（Task Registry）API。
function owns(pathname) {
  return pathname === '/tasks' || pathname.startsWith('/tasks/');
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;

    // ── 统一安装/更新任务（Task Registry）──
    // 全部安装·升级·卸载·更新操作收敛为同一任务模型（状态机 + step 进度 + 日志 + 持久化历史）。
    if (pathname === '/tasks') {
      if (req.method === 'GET') {
        const kind = new URL(req.url, 'http://localhost').searchParams.get('kind') || null;
        const ov = sup.tasks ? sup.tasks.overview() : { tasks: [], current: {} };
        if (kind) ov.tasks = ov.tasks.filter((t) => t.kind === kind);
        return send(200, ov);
      }
      return send(405, { error: 'method not allowed' });
    }
    if (pathname.startsWith('/tasks/')) {
      const rest = pathname.slice('/tasks/'.length);
      const segs = rest.split('/');
      // GET /tasks/:id → 单任务详情
      if (req.method === 'GET' && segs.length === 1) {
        const t = sup.tasks ? sup.tasks.get(segs[0]) : null;
        if (!t) return send(404, { error: 'task not found' });
        return send(200, sup.tasks.view(t));
      }
      // GET /tasks/:kind/current → 某类目标当前运行中任务
      if (req.method === 'GET' && segs.length === 2 && segs[1] === 'current') {
        const cur = sup.tasks ? sup.tasks.running().filter((t) => t.kind === segs[0]).map((t) => sup.tasks.view(t)) : [];
        return send(200, { items: cur });
      }
      return send(404, { error: 'not found' });
    }
  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
