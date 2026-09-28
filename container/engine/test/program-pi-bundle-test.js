'use strict';

// 第二个载荷（Program #2 = pi）可打包性冒烟（复检 AUD-G28）：
// 用仓库里**真实的** programs/pi 出包，校验包结构 / 签名可验 / 入口在 / 清单 name 正确 /
// 载荷不碰 Android API（公理 D）。设备侧"装第二个 Program"仍归 P9 真机验证。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packBundle } = require('../src/program-bundle');
const { extractZip } = require('../src/zip');
const { verifyManifest, sha256 } = require('../src/verify');
const makeRunner = require('./harness');

const { check, finish } = makeRunner('program-pi-bundle');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'programs', 'pi');
const mf = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

check('真实 pi 源清单存在且 role=agent', mf.id === 'pi' && mf.role === 'agent');
check('pi 入口文件真实存在', fs.existsSync(path.join(SRC, mf.entry)));

const kp = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const version = mf.version;
const { zipBuf, manifestJson, manifest } = packBundle({
  srcDir: SRC, version, privateKeyPem: kp.privateKey,
  url: 'https://ota.example/program-' + version + '.zip',
});

check('pi 包非空', Buffer.isBuffer(zipBuf) && zipBuf.length > 0);
check('包内清单 name=pi（授权表按 name 判，硬编码 console 是 bug）', manifestJson.name === 'pi');
check('包内清单 entry 来自源清单', manifestJson.entry === mf.entry);
check('包内清单带签名', typeof manifestJson.signature === 'string' && manifestJson.signature.length > 0);
check('manifest.sha256 === zip sha256', manifest.sha256 === sha256(zipBuf));

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ext-'));
extractZip(zipBuf, out);
const prefix = path.join(out, 'program', version);
check('解包得 program/<ver>/program-manifest.json', fs.existsSync(path.join(prefix, 'program-manifest.json')));
check('解包含入口 ' + mf.entry, fs.existsSync(path.join(prefix, mf.entry)));
const kj = JSON.parse(fs.readFileSync(path.join(prefix, 'program-manifest.json'), 'utf8'));
check('包内清单验签通过', verifyManifest(kp.publicKey, kj, kj.signature));

// 公理 D：载荷只碰 Node 标准库，不碰 Android。
const src = fs.readFileSync(path.join(SRC, mf.entry), 'utf8');
check('pi 不碰 Android API（公理 D）', !/LobosNative|android\.|require\(['"]android/.test(src));
check('pi 只 require Node 标准库', !/require\(['"]\.\.?\//.test(src));

// 多 Program 落位：安装根必须按 id —— 硬编码 programs/console 会让第二个 Program 覆盖面板。
const mgr = fs.readFileSync(path.join(ROOT, 'container/app/src/main/java/lobos/ota/ProgramManager.kt'), 'utf8');
check('ProgramManager 落位根按 id', mgr.includes('programs/" + programId'));

finish();
