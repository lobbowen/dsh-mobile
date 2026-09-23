'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 请求身份判定（唯一模块）—— P0-1 结构性修复。
//
// 信任根（唯一）：req.socket.remoteAddress —— 操作系统层的连接事实，
// 客户端无法伪造。请求头（Host/Origin/Referer）属于"浏览器语义"数据：
// - Host 头：仅用于防 DNS-rebinding 的深化校验（identity 已覆盖其安全职责）；
// - Origin 头：仅用于防跨站网页驱动的 CSRF 深化校验。
// 任何鉴权/敏感数据下发判定（token 下发、access-key 豁免）只允许消费本模块，
// 绝不允许重新从请求头推断"请求来自哪里"。
// ═══════════════════════════════════════════════════════════════════════════

/** 解析 socket 远端地址为规范 IPv4/IPv6 形态（去除 IPv4-mapped 前缀）。 */
function normalizeRemoteAddress(ra) {
  if (typeof ra !== 'string' || !ra) return null;
  // Node 对 IPv4-mapped IPv6 呈现 ::ffff:a.b.c.d —— 归一为 IPv4 字面量
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ra);
  return m ? m[1] : ra.toLowerCase();
}

function isLoopbackAddress(ra) {
  const a = normalizeRemoteAddress(ra);
  if (!a) return false;
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

function isPrivateIpv4(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const o = Number(m[1]), t = Number(m[2]);
  if (o === 10) return true;
  if (o === 172 && t >= 16 && t <= 31) return true;
  if (o === 192 && t === 168) return true;
  return false;
}

/** 是否来自本机回环（socket 事实）。 */
function socketIsLoopback(req) {
  return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
}

// ── 注：此处的 `socketIsTrusted()` 与 `identity.trusted` 字段已**删除**（2026-09-12，P2）──
//
// 它曾在每次请求里计算「本机或 RFC1918 私有网段」，但**全仓零消费**：
// 真实的两个判定点是
// · `identity.loopback` → token 下发 / access-key 豁免（api/index.js）
// · `originAllowed` → Host/Origin 闸（现已自带 isLocalOrLanHost，复用 isPrivateIpv4）
//
// 为什么**不是**「把它接上」而是删掉：
// 若把 access-key 门卫从 `!identity.loopback` 改成 `!identity.trusted`，
// 局域网（私有网段）来源就会被**豁免**访问密钥 —— 那是**安全降级**。
// 当前语义是「只有回环免 key，私网也要 key」，更严；该语义正确，应保留。
//
// 故这是**死字段**（算而不用），而非「漏接线」。删除它避免读者误以为
// 「私网已被信任」，从而据此放松某处判定。

/** 请求身份快照（每请求一次，分派器写入 ctx；域内不得重复判定）。
 *
 * 只保留**真正被消费**的两个字段：
 * · `remote` —— 诊断/日志用（原始 socket 地址归一化）
 * · `loopback` —— token 下发与 access-key 豁免的唯一依据
 */
function identify(req) {
  return {
    remote: normalizeRemoteAddress(req && req.socket && req.socket.remoteAddress),
    loopback: socketIsLoopback(req),
  };
}

module.exports = {
  identify,
  socketIsLoopback,
  // `socketIsTrusted` 已删除（2026-09-12）：死字段，且接入会安全降级 —— 见文件内说明。
  normalizeRemoteAddress,
  // P1-E：`isPrivateIpv4` 一并导出 —— `originAllowed` 的 Host/Origin 闸需要**同一份**
  // RFC1918 判定，不得在 api/index.js 里再写一遍（那正是「同一事实两处实现」的复发）。
  isPrivateIpv4,
  isLoopbackAddress,
};
