'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// ADB 无线调试门面（内核侧唯一入口）
//
// 把「密钥管理 / 配对 / 连接执行」收成一处，供 API 与 UI 调用：
//   · 密钥落 <supervisorDir>/adb/adbkey.pem（0600）——ADB 身份，跨重启复用；
//   · 配对成功后把「host + 连接端口 + GUID」落 <supervisorDir>/adb/state.json；
//   · shell() 默认走已持久化的连接端点，也可显式传 host/connectPort。
//
// 注意：配对端口与连接端口是**两个**端口（设备无线调试页与配对弹窗分别给出），
// 所以 pair() 需要 pairPort，并额外收 connectPort 以便后续直连。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const stateRoot = require('../platform/state-root');
const adbkey = require('./adbkey');
const pairing = require('./pairing');
const transport = require('./transport');

const ADB_DIR = 'adb';
const KEY_FILE = 'adbkey.pem';
const NAME_FILE = 'adbkey.name';
const STATE_FILE = 'state.json';

function dir() { return path.join(stateRoot.supervisorDir(), ADB_DIR); }
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
  dir, keyPath, namePath, statePath, ensureKey, readKey, status, pair, shell, forget, readState, writeState,
};
