'use strict';

// ADB RSA 密钥 + Android 524B 公钥格式 + ADB 语义签名
//
// 与阶段 1c 的 Kotlin 实现（AdbPublicKey/AdbKey）同源；Kotlin 副本已删除（ADR-0003 勘误）。
// 本文件是**壳侧唯一实现**，AOSP 向量由 container/engine/test/adb-client-test.js 钉住；
// 内核包（L1）里的旧副本退役是批次 2 的事，退役前以本文件为准。
//
// ⚠️ 签名语义：BoringSSL `RSA_sign(NID_sha1, digest, …)` 的 digest 是**已算好的摘要**，
//    AOSP 传原始 20B token ⇒ adbd 把 **token 本身当 SHA-1 摘要**。所以签名块是
//    00 01 FF…FF 00 || SHA1-DigestInfo || token，再做原始私钥运算。
//    用 `crypto.sign('sha1', …)`（SHA1withRSA）会签 SHA1(token)，adbd 必验不过。

const crypto = require('node:crypto');
const fs = require('node:fs');

const P32 = 1n << 32n;
const DIGEST_INFO_SHA1 = Buffer.from('3021300906052b0e03021a05000414', 'hex');

function egcd(a, b) { if (b === 0n) return [a, 1n, 0n]; const [g, x, y] = egcd(b, a % b); return [g, y, x - (a / b) * y]; }
function modInv(a, m) { const [g, x] = egcd(((a % m) + m) % m, m); if (g !== 1n) throw new Error('RSA: 模逆不存在'); return ((x % m) + m) % m; }
function toLe(v, len) { const o = Buffer.alloc(len); let t = v; for (let i = 0; i < len; i++) { o[i] = Number(t & 0xffn); t >>= 8n; } return o; }
function b64uToBig(s) { return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex')); }

/** 由 JWK（{n,e}）编码 Android 524B 公钥：words | n0inv | modulus(LE) | rr(LE) | exponent。 */
function publicKeyBlob(jwk) {
  const n = b64uToBig(jwk.n);
  const e = BigInt('0x' + Buffer.from(jwk.e, 'base64url').toString('hex'));
  const n0inv = (P32 - modInv(n % P32, P32)) % P32;
  const rr = (1n << 4096n) % n;
  const blob = Buffer.alloc(524);
  toLe(64n, 4).copy(blob, 0);
  toLe(n0inv, 4).copy(blob, 4);
  toLe(n, 256).copy(blob, 8);
  toLe(rr, 256).copy(blob, 264);
  toLe(e, 4).copy(blob, 520);
  return blob;
}

/** 生成一对 RSA-2048（e=65537）。 */
function generate(name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    jwk: publicKey.export({ format: 'jwk' }),
    name: name || 'dsh@device',
  };
}

/** 读取已有私钥（PEM）构造 key 对象；不存在则生成并以 0600 落盘。 */
function loadOrCreate(file, name) {
  if (fs.existsSync(file)) {
    const privatePem = fs.readFileSync(file, 'utf8');
    const jwk = crypto.createPublicKey(privatePem).export({ format: 'jwk' });
    return { privatePem, jwk, name: name || 'dsh@device' };
  }
  const k = generate(name);
  fs.writeFileSync(file, k.privatePem, { mode: 0o600 });
  return k;
}

/** adb 公钥串：`<base64 524B blob> <name>`。 */
function pubkeyString(key, name) {
  return publicKeyBlob(key.jwk).toString('base64') + ' ' + (name || key.name || 'dsh@device');
}

/** ADB token 签名（token 即 SHA-1 摘要；原始 PKCS#1 私钥运算）。返回 256B。 */
function signToken(key, token) {
  if (token.length !== 20) throw new Error('ADB token 必须 20 字节');
  const em = Buffer.alloc(256);
  em[0] = 0; em[1] = 1;
  const sep = 256 - token.length - DIGEST_INFO_SHA1.length - 1;
  em.fill(0xff, 2, sep);
  em[sep] = 0;
  DIGEST_INFO_SHA1.copy(em, sep + 1);
  token.copy(em, 256 - token.length);
  return crypto.privateDecrypt({ key: key.privatePem, padding: crypto.constants.RSA_NO_PADDING }, em);
}

module.exports = { generate, loadOrCreate, publicKeyBlob, pubkeyString, signToken };
