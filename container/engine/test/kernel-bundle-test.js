'use strict';

// 内核包：打包成 zip + kernel.json 签名 + manifest.sha256 一致；解包后可验签、含入口与 ui/dist。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packBundle, DEFAULT_ENTRY } = require('../src/kernel-bundle');
const { extractZip } = require('../src/zip');
const { verifyManifest, sha256 } = require('../src/verify');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('kernel-bundle');

const kp = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ksrc-'));
fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
fs.writeFileSync(path.join(src, 'bin', 'dsh-supervisor'), '#!/usr/bin/env node\nrequire("../src/supervisor").start();\n');
fs.mkdirSync(path.join(src, 'src'), { recursive: true });
fs.writeFileSync(path.join(src, 'src', 'x.js'), 'module.exports={};');
fs.mkdirSync(path.join(src, 'ui', 'dist'), { recursive: true });
fs.writeFileSync(path.join(src, 'ui', 'dist', 'supervisor.html'), '<html></html>');

const { zipBuf, kernelJson, manifest } = packBundle({
  srcDir: src, version: '1.4.0', privateKeyPem: kp.privateKey,
  requires: ['bridge:app_control'], url: 'http://ota.example/k.zip',
});

check('zipBuf 为 Buffer 且非空', Buffer.isBuffer(zipBuf) && zipBuf.length > 0);
check('kernel.json 含签名', typeof kernelJson.signature === 'string' && kernelJson.signature.length > 0);
check('entry 默认 bin/dsh-supervisor', kernelJson.entry === DEFAULT_ENTRY);
check('manifest.sha256 === zip sha256', manifest.sha256 === sha256(zipBuf));
check('manifest.version 一致', manifest.version === '1.4.0');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kext-'));
extractZip(zipBuf, out);
const kjPath = path.join(out, 'kernel', '1.4.0', 'kernel.json');
check('解包得到 kernel/<version>/kernel.json', fs.existsSync(kjPath));
const kj2 = JSON.parse(fs.readFileSync(kjPath, 'utf8'));
check('解包 kernel.json 验签通过', verifyManifest(kp.publicKey, kj2, kj2.signature));
check('解包含内核入口 bin/dsh-supervisor', fs.existsSync(path.join(out, 'kernel', '1.4.0', 'bin', 'dsh-supervisor')));
check('解包含 ui/dist/supervisor.html', fs.existsSync(path.join(out, 'kernel', '1.4.0', 'ui', 'dist', 'supervisor.html')));

// ── extractZip 加固：解压预算 / CRC 先于写盘 / 目录条目穿越 ──
// 预算临时调小做测试（zip.js 的守卫运行时读模块属性，真实值 64/128MB 在设备上不可达）。
const zip = require('../src/zip');
const realEntry = zip.ZIP_BUDGET.entryInflated, realTotal = zip.ZIP_BUDGET.totalInflated;
zip.ZIP_BUDGET.entryInflated = 4096; zip.ZIP_BUDGET.totalInflated = 8192;
try {
  const zeros = Buffer.alloc(2 * 1024 * 1024); // 高度可压：deflate 后远小于 4KB
  const bomb = zip.createZip(new Map([['big.bin', zeros]]), { compress: true });
  check('声明解压超预算的条目被拒（zip 炸弹）',
    (() => { try { zip.extractZip(bomb, fs.mkdtempSync(path.join(os.tmpdir(), 'bomb-'))); return false; }
      catch (e) { return /炸弹/.test(e.message); } })());

  // 撒谎包：中央目录声明解压后 0 字节，实际 deflate 出 2MB —— 声明闸拦不住，
  // 必须靠 inflateRawSync 的 maxOutputLength 在解压中截停。
  // 偏移按签名动态定位（写死 22/86 依赖"首个条目恰好是 big.bin"这一脆弱假设，
  // 假设定了就会指错字节、用例真空通过 —— 门禁必须真的能红）。
  const lie = Buffer.from(bomb);
  const kLocal = lie.indexOf(Buffer.from('big.bin'));      // 首个出现 = 局部头的名字字段
  const kCd = lie.lastIndexOf(Buffer.from('big.bin'));     // 末次出现 = 中央目录的名字字段
  if (kLocal < 0 || kCd <= kLocal) throw new Error('撒谎包构造失败：定位不到 big.bin 的两处头');
  lie.writeUInt32LE(0, kLocal - 18);  // 局部头 uncompressed size（签名@-26，字段在头内偏移 22）
  lie.writeUInt32LE(0, kCd - 20);     // 中央目录 uncompressed size（签名@-46，字段在头内偏移 26）
  check('声明撒谎的炸弹仍被 maxOutputLength 截停',
    (() => { try { zip.extractZip(lie, fs.mkdtempSync(path.join(os.tmpdir(), 'lie-'))); return false; }
      catch (e) { return /解压失败|炸弹/.test(e.message); } })());

  // CRC 先于写盘：篡改 Stored 内容字节 → 抛错且目标路径**无残留文件**。
  const z2 = zip.createZip(new Map([['ghost.bin', Buffer.from('hello')]]));
  const off = z2.indexOf(Buffer.from('hello'));
  const bad = Buffer.from(z2); bad[off] ^= 0xFF;
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-'));
  let crcThrew = false;
  try { zip.extractZip(bad, d2); } catch (e) { crcThrew = /CRC/.test(e.message); }
  check('CRC 失败先于写盘（目标无残留）', crcThrew && !fs.existsSync(path.join(d2, 'ghost.bin')));

  // 目录条目也能带 ../（旧实现只在文件分支防护，漏半边）。
  const z3 = zip.createZip(new Map([['../evil/', Buffer.alloc(0)]]));
  check('目录条目路径越界被拒',
    (() => { try { zip.extractZip(z3, fs.mkdtempSync(path.join(os.tmpdir(), 'dir-'))); return false; }
      catch (e) { return /越界/.test(e.message); } })());
} finally {
  zip.ZIP_BUDGET.entryInflated = realEntry; zip.ZIP_BUDGET.totalInflated = realTotal;
}

finish();
