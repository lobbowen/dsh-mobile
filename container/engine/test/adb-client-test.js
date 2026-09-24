'use strict';
// L0 adb-client 向量测试（原 Kotlin kernel/adb 测试套的 AOSP 向量迁移，D4）
//
// 被测对象是**壳自带的** assets/node/adb-client/（ADR-0003 勘误 2026-09-24：
// ADB 客户端唯一归属是 L0；Kotlin 副本与内核侧实现都会在收敛后消失，这里
// require 的相对路径就是发布产物本身 —— 测的就是设备上跑的字节）。
//
// 向量出处：AOSP system/core/libcrypto_utils/tests/android_pubkey_test.cpp
// （Apache-2.0），逐字节照抄 —— 与原 AdbPublicKeyTest.kt 同一来源。
// 这里钉的是**字节布局与签名语义**（最容易写错、真机上最难定位的两类）：
//   · 524B 小端 blob：words/n0inv/modulus/rr/exponent 五段的位置与值；
//   · ADB token 签名 = 把 token 本身当 SHA-1 摘要的原始 PKCS#1（不是 SHA1withRSA）。

const path = require('path');
const crypto = require('crypto');
const makeRunner = require('./harness');
const { check, finish } = makeRunner('adb-client');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ADB = path.join(ROOT, 'container', 'app', 'src', 'main', 'assets', 'node', 'adb-client');
const adbkey = require(path.join(ADB, 'adbkey.js'));
const transport = require(path.join(ADB, 'transport.js'));
const Ed = require(path.join(ADB, 'ed25519.js'));
const spake2 = require(path.join(ADB, 'spake2.js'));

const KEY_2048_HEX =
  '40000000057561d133f02d1245fbae0702154f3a2ba3bc49bd1407a0c09f0c5260779fa231d0a7fb7edefbc905c097f77499e6d108a6c2595ad8371de0485e6344048b0520f6256738b2b6f9beb61d7f1b718aebb7f801c15ef7fe4808270f272a641a438dcf5a335c18c5f4e7feeed31262ad61789a03b0afab915746bf18c6bc0c6b55cddac4cc98469199bca3ca6c86a61c8fcaf8f68a008e05d71343e2f21a13f35013a4f24e41b13678554c5e27c5c04bd893aa7ef090081026726db921ae4d014b551de71e5e316e62d13326cbdbfe7298c8061c12dffc74e57a6ff5a36308e302684d7c7005ec957e24a4bc4ccd3914b52a8fc1e34efaf870508fd58ec7b532894dbb6ac1c1a2425757bd2adca6fdc886446a035d4d28e1deb4a9a503617a5fb109172b9ca25428ad34c95f6c9fb8d2a978a7aab3112f659b4e670ccc2036bf262b4ec0d4bd2264c41c5669db5f89e175688d0eab1c101ac0125d6fbd09bb47cbe734ef56abeac3e97f9a3de92d146125375c3b4baf5a4bc8991a328f5407d3578a3d2af79e7e922a50e9d8dbd603d38e5432ce879392e775e16b781a85c246a131bbc7b91dd171e0e29b9c0da3cf934d877b65d9da4cd96aa636c2c7e333e2c383d1725430815e342c61eef44897b6aa476a0509d84d90afa84e82e48eb5e2658667e95b4b9a680830f6258b20da266fbd0da5d86a7b012fab7bb5fe62372d94432f4d1601000100';
const VECTOR_BLOB = Buffer.from(KEY_2048_HEX, 'hex');

const P32 = 1n << 32n;
function leToBig(b) { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; }
function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }

// ── 1. Android 524B 公钥 blob：编出的字节 == AOSP 向量的字节 ──
{
  // 从向量取 modulus（[8,264) 小端）与 exponent（[520,524) 小端），反推 JWK 再编码。
  const n = leToBig(VECTOR_BLOB.subarray(8, 264));
  const eLe = leToBig(VECTOR_BLOB.subarray(520, 524));
  const nHex = n.toString(16);
  const jwk = {
    n: Buffer.from(nHex.length % 2 ? '0' + nHex : nHex, 'hex').toString('base64url'),
    e: Buffer.from([1, 0, 1]).toString('base64url'), // 65537
  };
  const out = adbkey.publicKeyBlob(jwk);
  check('AOSP 向量重编码逐字节一致（524B）', out.length === 524 && out.equals(VECTOR_BLOB));
  check('exponent 向量正确（65537 小端收尾）', eLe === 65537n && VECTOR_BLOB.readUInt32LE(520) === 65537);
  check('modulus_size_words = 64', VECTOR_BLOB.readUInt32LE(0) === 64);

  // n0inv：定义式 n0 * n0inv ≡ -1 (mod 2^32)，且与向量字段一致（0xd1617505）。
  const n0inv = out.readUInt32LE(4);
  const n0 = n % P32;
  check('n0inv 满足 Montgomery 定义式', (n0 * BigInt(n0inv)) % P32 === P32 - 1n);
  check('n0inv 与 AOSP 向量一致', n0inv === 0xd1617505);

  // rr = 2^4096 mod n，且落在 [264,520)。
  const rr = leToBig(out.subarray(264, 520));
  check('rr = 2^4096 mod n', rr === (1n << 4096n) % n && rr < n);
}

// ── 2. adb 公钥串：base64(524B) + 空格 + name，padding 恰好一个 '=' ──
{
  const key = adbkey.generate('dsh@test');
  const s = adbkey.pubkeyString(key);
  const [b64, name] = s.split(' ');
  check('公钥串两段（base64 + 名字）', b64 && name === 'dsh@test');
  check('524 字节 → 700 字符、1 个 padding', b64.length === 700 && b64.endsWith('=') && !b64.endsWith('=='));
  check('base64 解回 524 字节', Buffer.from(b64, 'base64').length === 524);
}

// ── 3. ADB token 签名语义：token 本身当 SHA-1 摘要（历史踩坑点） ──
{
  const SHA1_DIGEST_INFO = Buffer.from('3021300906052b0e03021a05000414', 'hex');
  const key = adbkey.generate('dsh@test');
  const pub = crypto.createPublicKey(key.privatePem);
  const { n, e } = pub.export({ format: 'jwk' });
  const modulus = BigInt('0x' + (Buffer.from(n, 'base64url').toString('hex') || '0'));
  const exponent = BigInt('0x' + Buffer.from(e, 'base64url').toString('hex'));
  check('自生成密钥 e = 65537', exponent === 65537n);

  const token = Buffer.from(Array.from({ length: 20 }, (_, i) => (i * 7 + 1) & 0xff));
  const sig = adbkey.signToken(key, token);
  check('签名长度 256', sig.length === 256);

  // 公钥原始运算还原 EM（= BoringSSL RSA_verify_raw 检查的那串字节）。
  let em = modPow(BigInt('0x' + sig.toString('hex')), exponent, modulus).toString(16);
  em = Buffer.from(em.padStart(512, '0'), 'hex');
  const sep = 256 - token.length - SHA1_DIGEST_INFO.length - 1;
  const structureOk =
    em[0] === 0x00 && em[1] === 0x01 &&
    em.subarray(2, sep).equals(Buffer.alloc(sep - 2, 0xff)) &&
    em[sep] === 0x00 &&
    em.subarray(sep + 1, sep + 1 + SHA1_DIGEST_INFO.length).equals(SHA1_DIGEST_INFO) &&
    em.subarray(256 - token.length).equals(token);
  check('EM = 00 01 FF.. 00 || SHA1-DigestInfo || token 原文', structureOk);
  // 若误用 SHA1withRSA，末尾会变成 SHA1(token) —— 单独钉死这条反例。
  check('末尾是 token 原文而非 SHA1(token)', !em.subarray(256 - 20).equals(crypto.createHash('sha1').update(token).digest()));

  let threw = 0;
  for (const bad of [0, 19, 21, 32]) {
    try { adbkey.signToken(key, Buffer.alloc(bad)); } catch (_) { threw++; }
  }
  check('非 20 字节 token 全部拒绝（0/19/21/32）', threw === 4);
}

// ── 4. 线协议报文（原 AdbProtocolTest 中 JS 侧仍存在的部分） ──
{
  const payload = Buffer.from('hello');
  check('checksum 按无符号字节和（0xFF→255）',
    transport.checksum(Buffer.from([0xff])) === 255 &&
    transport.checksum(Buffer.from([1, 0xff, 0])) === 256 &&
    transport.checksum(Buffer.alloc(0)) === 0);

  const pkt = transport.makePacket('WRTE', 7, 9, payload);
  check('报文 = 24B 头 + payload', pkt.length === 24 + 5 && pkt.toString('ascii', 0, 4) === 'WRTE');
  check('头部字段小端一致', pkt.readUInt32LE(4) === 7 && pkt.readUInt32LE(8) === 9 && pkt.readUInt32LE(12) === 5);
  check('magic = command xor 0xffffffff', pkt.readUInt32LE(20) === ((transport.commandInt('WRTE') ^ 0xffffffff) >>> 0));
  check('checksum 字段落位', pkt.readUInt32LE(16) === 532 && payload.equals(pkt.subarray(24)));

  const shellPkt = transport.makePacket('OPEN', 1, 0, Buffer.from('shell:id\u0000', 'utf8'));
  const n = shellPkt.readUInt32LE(12);
  check('OPEN shell payload：NUL 结尾且长度 9', n === 9 && shellPkt[24 + n - 1] === 0 &&
    shellPkt.subarray(24, 24 + n).toString('utf8') === 'shell:id\u0000');

  const cnxn = transport.makePacket('CNXN', transport.VERSION, transport.MAX_PAYLOAD, Buffer.from('host::\u0000', 'utf8'));
  check('CNXN 版本与最大负载', cnxn.readUInt32LE(4) === 0x01000000 && cnxn.readUInt32LE(8) === 256 * 1024);
}

// ── 5. ed25519 / spake2：与 pairing.js 相同入口的自洽往返 ──
// spake2.js 与 ed25519.js 的头注释都声称「可在 CI 里逐条钉住」；这一节兑现它。
// 没有跨端向量可比（对端是设备），能钉的是：字节环不变性、非法输入拒绝、
// 同密码两端派生同 key / 错码异 key —— 正是真机配对踩过的三类坑。
{
  const B_HEX = '5866666666666666666666666666666666666666666666666666666666666666';
  check('基点 B 编解码回环 = RFC 8032 字节',
    Ed.encode(Ed.B).equals(Buffer.from(B_HEX, 'hex')) && Ed.decode(Ed.encode(Ed.B)).length === 2);
  check('M / N 固定点解码成功（非法会得 null）', Ed.M !== null && Ed.N !== null);
  check('恒等点编码为 01 00…',
    Buffer.compare(Ed.encode(Ed.IDENT), Buffer.concat([Buffer.from([1]), Buffer.alloc(31)])) === 0);
  // 点是 [BigInt,BigInt] 数组，没有 .equals —— 经 encode 成字节再比。
  check('l·B = 恒等（阶正确）',
    Buffer.compare(Ed.encode(Ed.mulScalar(Ed.L, Ed.B)), Ed.encode(Ed.IDENT)) === 0);
  check('decode 拒绝错误长度与 y≥P', Ed.decode(Buffer.alloc(31)) === null && Ed.decode(Buffer.alloc(32, 0xff)) === null);

  const run = (pwA, pwB) => {
    const alice = spake2.generateMsg('alice', pwA);
    const bob = spake2.generateMsg('bob', pwB);
    return [spake2.processMsg(alice, bob.msg), spake2.processMsg(bob, alice.msg)];
  };
  const pwd = Buffer.from('123456-abcde');
  const [ka, kb] = run(pwd, pwd);
  check('同密码往返：两端派生同一 64B key', ka.length === 64 && kb.length === 64 && ka.equals(kb));
  const [k1, k2] = run(pwd, Buffer.from('123456-abcdf'));
  check('错码：两端 key 不一致（且都非空）', k1.length === 64 && k2.length === 64 && !k1.equals(k2));
  // 非法 = **解码不出点**（y≥P）。注意别用全零：全零是 y=0 的合法 4 阶扭点，
  // 能解出来（本实现不做小序过滤，与真实配对路径语义一致），断言会假红。
  check('processMsg 对不可解码的对端点返回 null',
    spake2.processMsg(spake2.generateMsg('alice', pwd), Buffer.alloc(32, 0xff)) === null);
}

finish();
