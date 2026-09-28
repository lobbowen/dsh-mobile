'use strict';

// adb-client 命令行入口（Kotlin AdbClientRunner 的唯一调用面）
//
// 两种形态：
//   1. 一次性子命令（spawn → 干活 → stdout 结果行 → 退出）：
//        node cli.js status | pair | shell | forget
//      结果行协议：`LOBOS_ADB_RESULT {json}`（Kotlin 按前缀提取，允许自由调试输出）。
//      退出码：0=成功，1=失败（失败也在结果行里给 ok:false + error，不靠 stderr 归因）。
//   2. 常驻 serve（Kotlin 复用一个 Node 进程，消灭"每次 shell 新起 ~100MB libnode"）：
//        node cli.js serve
//      stdin 读换行分隔的 JSON-RPC 2.0 请求帧，stdout 写结果帧：
//        请求  {"jsonrpc":"2.0","id":<n>,"method":"shell","params":{"cmd":"id"}}
//        成功  {"jsonrpc":"2.0","id":<n>,"result":{"ok":true,"out":"...","logs":[]}}
//        失败  {"jsonrpc":"2.0","id":<n>,"error":{"code":-32000,"message":"..."}}
//      serve 的 stdout 是帧通道：任何诊断输出必须走 stderr，否则污染帧流。
//      方法：status / pair / shell / forget / channel / shutdown。
//
// 用法：
//   node cli.js status
//   node cli.js pair --host <h> --pair-port <p> --code <6-10位> [--connect-port <p>] [--timeout-ms <n>]
//   node cli.js shell --cmd "<command>" [--host <h> --connect-port <p>] [--timeout-ms <n>]
//   node cli.js forget
//   node cli.js serve
// 凭据目录：LOBOS_ADB_DIR（必填，容器注入 files/adb）。
// 迁移：--migrate-from <旧目录>（可选，内核 supervisorDir/adb → files/adb 的一次性搬家，
//       仅当目标无密钥且旧目录有密钥时执行；保住已配对身份，设备上免重新授权）。

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const adb = require('./index');

const RESULT_PREFIX = 'LOBOS_ADB_RESULT ';

// serve 模式下 stdout 只许有帧；一次性模式沿用旧行为（信息行可与结果行共存）。
let serveMode = false;
function logInfo(message) {
  (serveMode ? process.stderr : process.stdout).write(message + '\n');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[++i]; }
    else out._.push(a);
  }
  return out;
}

// 一次性迁移旧内核路径的凭据（幂等：目标已有 adbkey.pem 就绝不覆盖）。
function migrateFrom(srcDir) {
  try {
    if (!srcDir || !fs.existsSync(path.join(srcDir, 'adbkey.pem'))) return;
    if (fs.existsSync(adb.keyPath())) return;
    fs.mkdirSync(adb.dir(), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(srcDir, 'adbkey.pem'), adb.keyPath());
    fs.chmodSync(adb.keyPath(), 0o600);
    for (const [src, dst] of [['adbkey.name', adb.namePath()], ['state.json', adb.statePath()]]) {
      const s = path.join(srcDir, src);
      if (fs.existsSync(s)) fs.copyFileSync(s, dst);
    }
    logInfo('migrated adb credentials from ' + srcDir);
  } catch (e) {
    logInfo('migrate skipped: ' + e.message);
  }
}

/**
 * 唯一的方法派发：一次性子命令与 serve 帧共用同一条实现，避免两套语义漂移。
 * 返回值与一次性结果行里的对象**完全同名同形**（serve 的 result 直接是它）。
 */
async function dispatch(method, params) {
  const p = params || {};
  switch (method) {
    case 'status':
      return { ok: true, status: adb.status() };
    case 'forget':
      adb.forget();
      return { ok: true };
    case 'pair': {
      if (!p.host || !p.pairPort || !p.code) throw new Error('pair 需要 host/pairPort/code');
      const r = await adb.pair({
        host: p.host, pairPort: Number(p.pairPort), code: String(p.code),
        connectPort: p.connectPort ? Number(p.connectPort) : undefined,
        timeoutMs: p.timeoutMs,
      });
      return { ok: true, guid: r.guid, status: adb.status() };
    }
    case 'shell': {
      if (p.cmd === undefined) throw new Error('shell 需要 cmd');
      const r = await adb.shell({
        cmd: p.cmd, host: p.host,
        connectPort: p.connectPort ? Number(p.connectPort) : undefined,
        timeoutMs: p.timeoutMs,
      });
      return { ok: true, out: r.out, logs: r.logs };
    }
    case 'channel':
      return adb.channel();
    case 'shutdown':
      return { ok: true };
    default:
      throw new Error('未知方法: ' + String(method) + '（可用：status/pair/shell/forget/channel/shutdown）');
  }
}

function paramsFromArgs(args, timeoutMs) {
  const sub = args._[0];
  const p = {};
  if (sub === 'pair') {
    p.host = args.host;
    p.pairPort = args['pair-port'];
    p.code = args.code;
    if (args['connect-port']) p.connectPort = Number(args['connect-port']);
    p.timeoutMs = timeoutMs;
  } else if (sub === 'shell') {
    p.cmd = args.cmd;
    p.host = args.host;
    if (args['connect-port']) p.connectPort = Number(args['connect-port']);
    p.timeoutMs = timeoutMs;
  }
  return p;
}

function writeFrame(obj) {
  // 单次 write 整行：管道写小于 PIPE_BUF 是原子的，多路响应不会互相穿插。
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 常驻模式：一行一帧，请求可并发；进程存活到 stdin 结束或收到 shutdown。 */
async function serve() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let req;
    try { req = JSON.parse(text); }
    catch (e) {
      writeFrame({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败: ' + e.message } });
      return;
    }
    const id = (req && req.id !== undefined) ? req.id : null;
    if (!req || typeof req.method !== 'string') {
      writeFrame({ jsonrpc: '2.0', id, error: { code: -32600, message: '缺 method' } });
      return;
    }
    const task = Promise.resolve()
      .then(() => dispatch(req.method, req.params))
      .then((result) => writeFrame({ jsonrpc: '2.0', id, result }))
      .catch((err) => writeFrame({
        jsonrpc: '2.0', id, error: { code: -32000, message: String((err && err.message) || err) },
      }));
    inFlight.add(task);
    task.then(() => inFlight.delete(task), () => inFlight.delete(task));
    if (req.method === 'shutdown') rl.close();
  });

  await new Promise((resolve) => rl.on('close', resolve));
  await Promise.allSettled([...inFlight]);
  await adb.closeAll().catch(() => {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];
  serveMode = sub === 'serve';
  migrateFrom(args['migrate-from']);
  const timeoutMs = args['timeout-ms'] ? Number(args['timeout-ms']) : undefined;

  if (sub === 'serve') { await serve(); return { __serve: true }; }
  if (!sub) throw new Error('缺子命令（可用：status/pair/shell/forget/serve）');
  return await dispatch(sub, paramsFromArgs(args, timeoutMs));
}

// 不用 process.exit()：对管道（Kotlin 读的是 pipe）stdout 写入是异步的，exit 可能截断结果行；
// 设 exitCode 让事件循环自然收尾，保证结果行完整落管道。
main()
  .then(async (res) => {
    if (res && res.__serve) return; // serve 自己管收尾
    // 常驻会话必须显式收掉，否则 socket 会把事件循环钉住、一次性 CLI 永不退出。
    await adb.closeAll().catch(() => {});
    process.stdout.write(RESULT_PREFIX + JSON.stringify(res) + '\n');
    process.exitCode = 0;
  })
  .catch(async (err) => {
    if (serveMode) {
      // serve 的 stdout 只能有帧；启动失败写 stderr，父进程按 EOF 判死。
      process.stderr.write('adb-client serve 启动失败: ' + String((err && err.message) || err) + '\n');
      process.exitCode = 1;
      return;
    }
    await adb.closeAll().catch(() => {});
    process.stdout.write(RESULT_PREFIX + JSON.stringify({ ok: false, error: String((err && err.message) || err) }) + '\n');
    process.exitCode = 1;
  });
