#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// ADB 无线配对 —— 纯密码学/格式层回归（无网络、无真机）
//
// 覆盖：
//   E* Ed25519 群运算与 BoringSSL 固定 M/N（SPAKE2 的地基）
//   S* SPAKE2 自洽（同码两端同 key / 错码不同 key / password_hash 必须 64B）
//   K* Android 524B 公钥格式 + ADB 语义签名（token 即 SHA-1 摘要）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const Ed = require(path.join(ROOT, 'src', 'adb', 'ed25519'));
const SPAKE2 = require(path.join(ROOT, 'src', 'adb', 'spake2'));
const AdbKey = require(path.join(ROOT, 'src', 'adb', 'adbkey'));

// ── E：Ed25519 群 ──
check('E1 l*B == 单位元', Ed.encode(Ed.mulScalar(Ed.L, Ed.B)).equals(Ed.encode(Ed.IDENT)));
check('E2 (l+1)*B == B', Ed.encode(Ed.mulScalar(Ed.L + 1n, Ed.B)).equals(Ed.encode(Ed.B)));
check('E3 2B+B == 3B', Ed.encode(Ed.add(Ed.mulScalar(2n, Ed.B), Ed.B)).equals(Ed.encode(Ed.mulScalar(3n, Ed.B))));
check('E4 M 在曲线上且编码还原', Ed.toHex(Ed.encode(Ed.M)) === '5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e');
check('E5 N 在曲线上且编码还原', Ed.toHex(Ed.encode(Ed.N)) === '10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778');
check('E6 scReduce(l) == 0', Ed.scReduce(Ed.bigToLe(Ed.L, 64)) === 0n);
check('E7 scReduce(1) == 1', Ed.scReduce(Ed.bigToLe(1n, 64)) === 1n);
check('E8 非规范点（y >= p）被拒绝', Ed.decode(Buffer.alloc(32, 0xff)) === null);

// ── S：SPAKE2 自洽 ──
{
  const pw = Buffer.from('123456', 'latin1');
  const a = SPAKE2.generateMsg('alice', pw, crypto.randomBytes(64));
  const b = SPAKE2.generateMsg('bob', pw, crypto.randomBytes(64));
  const ka = SPAKE2.processMsg(a, b.msg);
  const kb = SPAKE2.processMsg(b, a.msg);
  check('S1 同码两端同 key', !!(ka && kb && ka.equals(kb)));
  check('S2 key material 64B', !!(ka && ka.length === 64));
  // 回归：BoringSSL password_hash[64] 是完整 SHA512，曾误用前 32B 导致真机 GCM 解密失败
  check('S3 password_hash 必须 64B', a.pwHash.length === 64, 'len=' + a.pwHash.length);
  check('S4 消息 32B', a.msg.length === 32 && b.msg.length === 32);

  const b2 = SPAKE2.generateMsg('bob', Buffer.from('000000', 'latin1'), crypto.randomBytes(64));
  const k2 = SPAKE2.processMsg(a, b2.msg);
  check('S5 错码两端 key 不同', !!(k2 && !k2.equals(ka)));
  check('S6 身份字符串含 NUL（16B）', SPAKE2.NAME_CLIENT.length === 16 && SPAKE2.NAME_CLIENT[15] === 0);
}

// ── K：ADB 密钥与签名 ──
{
  const key = AdbKey.generate('dsh@device');
  const blob = AdbKey.publicKeyBlob(key.jwk);
  const n = AdbKey.b64uToBig(key.jwk.n);
  check('K1 公钥 blob 524B', blob.length === 524, 'len=' + blob.length);
  check('K2 modulus_size_words == 64', blob.readUInt32LE(0) === 64);
  check('K3 exponent == 65537', blob.readUInt32LE(520) === 65537);
  const n0 = n % (1n << 32n);
  const n0inv = BigInt(blob.readUInt32LE(4));
  check('K4 n0inv 定义（n0*n0inv ≡ -1 mod 2^32）', (n0 * n0inv) % (1n << 32n) === (1n << 32n) - 1n);

  const token = crypto.randomBytes(20);
  const sig = AdbKey.signToken(key, token);
  const e = BigInt('0x' + Buffer.from(key.jwk.e, 'base64url').toString('hex'));
  const m = Ed.modPow(BigInt('0x' + sig.toString('hex')), e, n);
  let hex = m.toString(16); if (hex.length % 2) hex = '0' + hex;
  const rec = Buffer.concat([Buffer.alloc(256 - hex.length / 2), Buffer.from(hex, 'hex')]);
  const sep = 256 - 20 - 15 - 1;
  check('K5 签名还原末尾 == token 原文', rec.subarray(256 - 20).equals(token));
  check('K6 还原块头 00 01 且分隔符 00', rec[0] === 0 && rec[1] === 1 && rec[sep] === 0);
  check('K7 SHA1 DigestInfo 前缀正确', rec.subarray(sep + 1, sep + 1 + 15).equals(AdbKey.DIGEST_INFO_SHA1));
  check('K8 pubkey 串 = base64(blob) + 空格 + name',
    AdbKey.pubkeyString(key).startsWith(blob.toString('base64') + ' dsh@device'));
}

const failed = results.filter((x) => !x).length;
console.log('\n结果: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
