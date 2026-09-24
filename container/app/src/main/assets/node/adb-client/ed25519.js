'use strict';

// Ed25519 群运算（纯 BigInt，零依赖）
//
// 用途：复刻 BoringSSL `crypto/curve25519/spake25519.cc` 的 SPAKE2 —— ADB 无线调试
// 的「使用配对码配对设备」用它做 PAKE。两个关键事实（读源码核对的，别凭记忆）：
//   · BoringSSL 的 SPAKE2 跑在 **Ed25519 群**上（不是 NIST P-256）；
//   · M/N 是**固定点**（编码见下），身份只进 transcript，不参与 M/N 派生。
//
// 本文件只做数学，不碰网络/文件，因此完全可以在 CI 里逐条钉住。
// 参考：RFC 8032、BoringSSL spake25519.cc（Apache-2.0）；独立实现，未复制代码。

const P = (1n << 255n) - 19n;
// 素数阶子群的阶 l = 2^252 + 27742317777372353535851937790883648493
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function mod(x) { x %= P; if (x < 0n) x += P; return x; }
function modPow(b, e, m) {
  b %= m; if (b < 0n) b += m;
  let r = 1n;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
function inv(x) { return modPow(mod(x), P - 2n, P); }

// d = -121665/121666 mod p
const D = mod(-121665n * inv(121666n));
const IDENT = [0n, 1n];

// RFC 8032 仿射加法（a = -1）：-x^2 + y^2 = 1 + d x^2 y^2
function add(a, b) {
  const x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
  const k = mod(D * x1 * x2 * y1 * y2);
  return [mod((x1 * y2 + x2 * y1) * inv(1n + k)), mod((y1 * y2 + x1 * x2) * inv(1n - k))];
}
function neg(a) { return [mod(-a[0]), a[1]]; }
function sub(a, b) { return add(a, neg(b)); }

function mulScalar(k, pt) {
  let r = IDENT, q = pt, n = k;
  if (n < 0n) { q = neg(q); n = -n; }
  while (n > 0n) { if (n & 1n) r = add(r, q); q = add(q, q); n >>= 1n; }
  return r;
}

const SQRTM1 = modPow(2n, (P - 1n) / 4n, P);
function recoverX(y, sign) {
  const y2 = (y * y) % P;
  const xx = (mod(y2 - 1n) * inv(mod(D * y2 + 1n))) % P;
  let x = modPow(xx, (P + 3n) / 8n, P);
  if ((x * x) % P !== xx) x = (x * SQRTM1) % P;
  if ((x * x) % P !== xx) return null;
  if ((x & 1n) !== BigInt(sign)) x = mod(-x);
  return x;
}

const HEX = '0123456789abcdef';
function toHex(bytes) { let s = ''; for (const b of bytes) s += HEX[(b >> 4) & 15] + HEX[b & 15]; return s; }
function fromHex(h) { const o = Buffer.alloc(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; }
function leToBig(bytes) { let v = 0n; for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]); return v; }
function bigToLe(v, len) { const o = Buffer.alloc(len); let t = v; for (let i = 0; i < len; i++) { o[i] = Number(t & 0xffn); t >>= 8n; } return o; }

function decode(bytes) {
  if (bytes.length !== 32) return null;
  const b = Buffer.from(bytes);
  const sign = (b[31] >> 7) & 1;
  b[31] &= 0x7f;
  const y = leToBig(b);
  if (y >= P) return null;
  const x = recoverX(y, sign);
  if (x === null) return null;
  return [x, y];
}
function encode(pt) {
  const out = bigToLe(pt[1], 32);
  if (pt[0] & 1n) out[31] |= 0x80;
  return out;
}

// 标准基点（y = 4/5，符号位 0）
const B = decode(fromHex('5866666666666666666666666666666666666666666666666666666666666666'));
// BoringSSL 里 SPAKE2 的固定 M / N 点（spake25519.cc 顶部注释给出编码）
const M = decode(fromHex('5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e'));
const N = decode(fromHex('10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778'));

/** 64 字节小端数按 mod l 归约（等价 BoringSSL x25519_sc_reduce）。 */
function scReduce(bytes) { return leToBig(bytes) % L; }

module.exports = {
  P, L, D, IDENT, add, neg, sub, mulScalar, decode, encode, scReduce, B, M, N,
};
