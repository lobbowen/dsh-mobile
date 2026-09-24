'use strict';

// BoringSSL 兼容的 SPAKE2（复刻 crypto/curve25519/spake25519.cc）
//
// 角色：ADB 客户端 = alice，设备 = bob。身份字符串长度含结尾 NUL（AOSP 用 sizeof()）。
// ⚠️ 最容易踩的坑：BoringSSL `SPAKE2_CTX.password_hash` 是 **64 字节**
//    （完整 SHA512(password)），transcript 里必须放 64B。曾误用前 32B，
//    真机表现为 PeerInfo 的 AES-GCM 解密失败（两端派生密钥不一致）。
//
// 只做密码学，不碰网络，因此 CI 可自洽验证（同码两端同 key / 错码不同 key）。

const crypto = require('node:crypto');
const Ed = require('./ed25519');

const NAME_CLIENT = Buffer.from('adb pair client\u0000', 'latin1'); // 16B（含 NUL）
const NAME_SERVER = Buffer.from('adb pair server\u0000', 'latin1'); // 16B（含 NUL）

function sha512(b) { return crypto.createHash('sha512').update(b).digest(); }
function lenPrefixed(b) {
  const l = Buffer.alloc(8);
  l.writeBigUInt64LE(BigInt(b.length), 0);
  return Buffer.concat([l, b]);
}

// 密码标量。BoringSSL 为修「低 3 位泄漏」给标量加 l/2l/4l 使之为 8 的倍数（cofactor hack）。
function passwordScalar(password) {
  let s = Ed.scReduce(sha512(password));
  if (s & 1n) s += Ed.L;
  if (s & 2n) s += 2n * Ed.L;
  if (s & 4n) s += 4n * Ed.L;
  return s;
}

/**
 * 生成我方 SPAKE2 消息。
 * @param {'alice'|'bob'} role
 * @param {Buffer} password
 * @param {Buffer} [randomBytes64] 仅测试用（固定随机以复现）；默认 crypto 随机。
 */
function generateMsg(role, password, randomBytes64) {
  const rnd = randomBytes64 || crypto.randomBytes(64);
  if (rnd.length !== 64) throw new Error('spake2 random 必须 64 字节');
  const priv = Ed.scReduce(rnd) * 8n; // BoringSSL: sc_reduce 后 left_shift_3
  const P = Ed.mulScalar(priv, Ed.B);
  const pwHash = sha512(password); // 64B！BoringSSL password_hash[64]
  const pwScalar = passwordScalar(password);
  const mask = Ed.mulScalar(pwScalar, role === 'alice' ? Ed.M : Ed.N);
  return { msg: Ed.encode(Ed.add(P, mask)), priv, pwHash, pwScalar, role };
}

/** 处理对端消息，返回 64B key material；对端点非法时返回 null。 */
function processMsg(state, theirMsg) {
  const Qstar = Ed.decode(theirMsg);
  if (Qstar === null) return null;
  const peersMask = Ed.mulScalar(state.pwScalar, state.role === 'alice' ? Ed.N : Ed.M);
  const Qext = Ed.sub(Qstar, peersMask);
  const dhEnc = Ed.encode(Ed.mulScalar(state.priv, Qext));

  const myName = state.role === 'alice' ? NAME_CLIENT : NAME_SERVER;
  const theirName = state.role === 'alice' ? NAME_SERVER : NAME_CLIENT;
  const parts = state.role === 'alice'
    ? [myName, theirName, state.msg, theirMsg]
    : [theirName, myName, theirMsg, state.msg];

  const h = crypto.createHash('sha512');
  for (const p of parts) h.update(lenPrefixed(Buffer.from(p)));
  h.update(lenPrefixed(dhEnc));
  h.update(lenPrefixed(state.pwHash));
  return h.digest();
}

module.exports = { generateMsg, processMsg };
