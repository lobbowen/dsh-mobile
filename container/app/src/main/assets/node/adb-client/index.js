'use strict';

// ADB 无线调试门面（L0 容器侧，随 APK 冻结）
//
// 把「密钥管理 / 配对 / 连接执行」收成一处，供 AdbClientRunner（Kotlin）经
// cli.js 调用：
//   · 密钥落 <DSH_ADB_DIR>/adbkey.pem（0600）——ADB 身份，跨重启复用；
//   · 配对成功后把「host + 连接端口 + GUID」落 <DSH_ADB_DIR>/state.json；
//   · shell() 默认走已持久化的连接端点，也可显式传 host/connectPort。
//
// 为什么在容器侧而不在内核：凭据生命周期必须与信任根（APK）同层——
// 内核是 OTA 可换的 JS 包，不该持久持有 uid 2000 通道的密钥；特权执行统一
// 经桥方法 shell.exec 出口，保证门禁与审计。决策与理由见 ADR-0003（勘误 2026-09-24）。
//
// 目录注入：DSH_ADB_DIR 环境变量（由 AdbClientRunner 传入 files/adb）。
// 缺失即抛错——绝不悄悄落到别处产生第二把身份密钥。

const fs = require('node:fs');
const path = require('node:path');
const adbkey = require('./adbkey');
const pairing = require('./pairing');
const transport = require('./transport');

const KEY_FILE = 'adbkey.pem';
const NAME_FILE = 'adbkey.name';
const STATE_FILE = 'state.json';

function dir() {
  const d = process.env.DSH_ADB_DIR;
  if (!d) throw new Error('DSH_ADB_DIR 未注入（adb-client 必须由容器指定凭据目录）');
  return d;
}
function keyPath() { return path.join(dir(), KEY_FILE); }
function namePath() { return path.join(dir(), NAME_FILE); }
function statePath() { return path.join(dir(), STATE_FILE); }
function ensureDir() { fs.mkdirSync(dir(), { recursive: true, mode: 0o700 }); }

// 公钥串里的 name 必须**跨读取稳定**：否则每次重新加载密钥都会回落成默认名，
// 同一把密钥会产生不同的公钥串（真机上表现为"已授权 key 对不上"）。落一个 sidecar。
function applyStoredName(key, fallback) {
  try {
    if (fs.existsSync(namePath())) { key.name = fs.readFileSync(namePath(), 'utf8').trim() || fallback; return key; }
    key.name = fallback;
    fs.writeFileSync(namePath(), key.name, { mode: 0o600 });
  } catch (e) { /* ignore */ }
  return key;
}

/** 读取已有 ADB 密钥（name 以 sidecar 为准）；不存在返回 null。 */
function readKey() {
  if (!fs.existsSync(keyPath())) return null;
  return applyStoredName(adbkey.loadOrCreate(keyPath()), 'dsh@device');
}

/** 读取已有 ADB 密钥；不存在则生成并落盘（0600 + name sidecar）。 */
function ensureKey(name) {
  ensureDir();
  return applyStoredName(adbkey.loadOrCreate(keyPath(), name || 'dsh@device'), name || 'dsh@device');
}

function readState() { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return null; } }
function writeState(s) { ensureDir(); fs.writeFileSync(statePath(), JSON.stringify(s, null, 2), { mode: 0o600 }); }
function forget() { try { fs.unlinkSync(statePath()); } catch (e) { /* ignore */ } }

/** 当前状态（只读，不产生副作用）。 */
function status() {
  const st = readState();
  let pubkey = null;
  const key = readKey();
  if (key) pubkey = adbkey.pubkeyString(key);
  return {
    keyPath: keyPath(),
    pubkey: pubkey,
    paired: !!st,
    host: (st && st.host) || null,
    connectPort: (st && st.connectPort) || null,
    guid: (st && st.guid) || null,
    name: (st && st.name) || null,
    pairedAt: (st && st.pairedAt) || null,
  };
}

/**
 * 配对并（可选）持久化连接端点。
 * @param {{host:string, pairPort:number, code:string, connectPort?:number, name?:string, timeoutMs?:number}} o
 */
async function pair(o) {
  const key = ensureKey(o && o.name);
  const r = await pairing.pair({ host: o.host, port: o.pairPort, code: o.code, key: key, timeoutMs: o.timeoutMs });
  if (o.connectPort) {
    writeState({ host: o.host, connectPort: o.connectPort, guid: r.guid, name: key.name, pairedAt: new Date().toISOString() });
  }
  return { guid: r.guid, type: r.type };
}

/**
 * 在已配对设备上执行 shell 命令。
 * @param {{cmd:string, host?:string, connectPort?:number, timeoutMs?:number}} o
 */
async function shell(o) {
  const st = readState();
  const host = o.host || (st && st.host);
  const port = o.connectPort || (st && st.connectPort);
  if (!host || !port) throw new Error('未配对或缺少连接地址（host/connectPort）');
  return transport.shell({ host: host, port: port, key: ensureKey(), cmd: o.cmd, timeoutMs: o.timeoutMs });
}

module.exports = {
  keyPath, namePath, statePath, status, pair, shell, forget,
};
