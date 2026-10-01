'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

/**
 * 端口监听检查（L1 层）：能建立 TCP 连接即视为有进程在监听。
 * 说明：这是「在线」判定基础，不做 HTTP 语义。
 */
function portListening(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(ok);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * HTTP 探活（L2 层）：GET healthUrl，服务在线即健康（2xx 或 401/403 认证响应）。
 * 假死识别（事件循环卡死但端口仍在监听）依赖此层：
 * 进程在、端口在、HTTP 不响应 → 判不健康。
 * 任何异常（超时/拒绝/非 2xx/URL 非法）都 resolve(false)，绝不 reject。
 */
function httpProbe(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, status) => {
      if (done) return;
      done = true;
      resolve({ ok: !!ok, status });
    };
    let u;
    try {
      u = new URL(url);
    } catch {
      return finish(false, null);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'dsh-supervisor-probe' },
      },
      (res) => {
        // 只关心状态码，body 直接排空避免连接悬挂
        res.resume();
        const sc = res.statusCode;
        finish((sc >= 200 && sc < 300) || sc === 401 || sc === 403, sc); // 401/403 = 服务在线（认证保护），非故障
      }
    );
    req.on('timeout', () => {
      req.destroy();
      finish(false, null);
    });
    req.on('error', () => finish(false, null));
  });
}

module.exports = { portListening, httpProbe };