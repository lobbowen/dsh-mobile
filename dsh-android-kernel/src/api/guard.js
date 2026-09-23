'use strict';

// 域：守卫/设置 API（changelog·guard 版本·settings·env·ports）。
// 已删除的端点（勿回潮）：
// · /autostart —— 开机自启（systemd + linger + GUI）：安卓常驻由 APK 容器 / Android Service 决定；
// · /settings/close-action —— 关窗隐藏到托盘：PC 桌面壳能力；
// · /self-update/* —— 内核自更新：单写入者 = 安卓容器 OTA，内核不持有任何自更新端点。
const fs = require('node:fs');
const path = require('node:path');

function owns(pathname) {
  return pathname === '/changelog' || pathname.startsWith('/guard/')
    || pathname.startsWith('/settings/')
    || pathname === '/env/dsh' || pathname === '/env/status' || pathname === '/env/node-lts'
    || pathname === '/ports';
}

/** 更新日志（DSH）：只展示 DeepSeek Harness 相关内容（来自 NativeManager 版本信息），与管家无关。
 * 命名统一（A4）：UI 中该能力位于「概览」页的「版本与升级」区块（非独立页面）——
 * 历史注释曾按独立页面描述，易误导；此处按真实位置表述。 */
function fetchDshChangelog(res, sup) {
  const v = (sup && sup.nativeManager) ? sup.nativeManager.versionInfo() : {};
  const inst = v.installed || '未安装';
  const latest = v.latest || '—';
  const upd = v.updateAvailable;
  const md = 'DeepSeek Harness（DSH）更新日志\n\n'
    + '当前安装：' + inst + '\n'
    + '最新版本：' + latest + '\n'
    + (upd ? ('检测到新版本，可在「概览 · 版本与升级」一键升级到 ' + latest + '。\n') : '当前已是最新版本。\n')
    + '\n完整变更记录见 DeepSeek Harness GitHub Releases：\n'
    + 'https://github.com/deepseek-ai/DeepSeek-Harness/releases\n';
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end(md);
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;
    // 更新日志：概览「版本与升级」只关心 DeepSeek Harness（DSH）
    if (req.method === 'GET' && pathname === '/changelog') {
      return fetchDshChangelog(res, sup);
    }
    // 管家自身更新日志（本地仓库 CHANGELOG.md）
    if (req.method === 'GET' && pathname === '/guard/changelog') {
      try {
        const md = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(md);
      } catch {
        return send(404, { error: 'changelog not found' });
      }
    }
    // 管家自身版本（设置页展示）：GET=本地视图（无网络 I/O，同步安全）；POST=完整检查（异步 fetch）
    if (req.method === 'GET' && pathname === '/guard/version') {
      return send(200, sup.guardVersionLocal());
    }
    if (req.method === 'POST' && pathname === '/guard/version/check') {
      req.resume();
      if (!originAllowed(req, sup.config.apiPort)) return send(403, { ok: false, error: 'cross-origin request rejected' });
      return sup.guardVersionCheck().then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }

    // 管家面板局域网访问开关（0.0.0.0 <-> 127.0.0.1）
    if (req.method === 'GET' && pathname === '/settings/lan') {
      return send(200, sup.lanPanelStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/lan') {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      collectBody(req, res, 1024, (body) => {
        let enabled = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.enabled === 'boolean') enabled = j.enabled; } catch {}
        if (enabled === null) return send(400, { ok: false, error: '需要 {"enabled":true|false}' });
        const r = sup.setLanPanel(enabled);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }
    // 出回环访问密钥（F2 定案）：状态查询 / 设置/清除（空 key=清除）。不回显明文。
    if (req.method === 'GET' && pathname === '/settings/access-key') {
      return send(200, sup.accessKeyStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/access-key') {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      collectBody(req, res, 4096, (body) => {
        let key = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.key === 'string') key = j.key; } catch {}
        if (key === null) return send(400, { ok: false, error: '需要 {"key":"<访问密钥>"}（空串清除）' });
        if (key && key.length < 8) return send(400, { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' });
        const r = sup.setAccessKey(key);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/env/dsh') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return send(200, sup.dshenvStatus());
    }
    if (req.method === 'GET' && pathname === '/env/status') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return send(200, sup.envStatus());
    }
    if (req.method === 'GET' && pathname === '/env/node-lts') {
      // Node LTS 在线检查（6h 缓存 + 失败降级，见 supervisor.nodeLtsStatus）
      return sup.nodeLtsStatus().then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }

    // 统一端口管理清单（全系统端口登记：固定/实例/分配，含 owner 对应关系 + 激活探测）——经 sup 门面取数
    if (req.method === 'GET' && pathname === '/ports') {
      return Promise.resolve(sup.listPorts()).then((r) => send(200, r)).catch((e) => send(500, { error: e && e.message }));
    }
  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
