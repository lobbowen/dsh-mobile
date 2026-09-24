'use strict';

// adb-client 一次性 CLI（Kotlin AdbClientRunner 的唯一调用面）
//
// 形态与 kernel-verify.js 同构：spawn → 干活 → stdout 结果行 → 退出。
// 结果行协议：`DSH_ADB_RESULT {json}`（Kotlin 侧按前缀提取，允许自由调试输出）。
// 退出码：0=成功，1=失败（失败也在结果行里给 ok:false + error，不靠 stderr 归因）。
//
// 用法：
//   node cli.js status
//   node cli.js pair --host <h> --pair-port <p> --code <6-10位> [--connect-port <p>] [--timeout-ms <n>]
//   node cli.js shell --cmd "<command>" [--host <h> --connect-port <p>] [--timeout-ms <n>]
//   node cli.js forget
// 凭据目录：DSH_ADB_DIR（必填，容器注入 files/adb）。
// 迁移：--migrate-from <旧目录>（可选，内核 supervisorDir/adb → files/adb 的一次性搬家，
//       仅当目标无密钥且旧目录有密钥时执行；保住已配对身份，设备上免重新授权）。

const fs = require('node:fs');
const path = require('node:path');
const adb = require('./index');

const RESULT_PREFIX = 'DSH_ADB_RESULT ';

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
    console.log('migrated adb credentials from ' + srcDir);
  } catch (e) {
    console.log('migrate skipped: ' + e.message);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  migrateFrom(args['migrate-from']);
  const sub = args._[0];
  const timeoutMs = args['timeout-ms'] ? Number(args['timeout-ms']) : undefined;

  if (sub === 'status') return { ok: true, status: adb.status() };
  if (sub === 'forget') { adb.forget(); return { ok: true }; }

  if (sub === 'pair') {
    if (!args.host || !args['pair-port'] || !args.code) throw new Error('pair 需要 --host/--pair-port/--code');
    const r = await adb.pair({
      host: args.host, pairPort: Number(args['pair-port']), code: String(args.code),
      connectPort: args['connect-port'] ? Number(args['connect-port']) : undefined, timeoutMs: timeoutMs,
    });
    return { ok: true, guid: r.guid, status: adb.status() };
  }

  if (sub === 'shell') {
    if (args.cmd === undefined) throw new Error('shell 需要 --cmd');
    const r = await adb.shell({
      cmd: args.cmd, host: args.host, connectPort: args['connect-port'] ? Number(args['connect-port']) : undefined,
      timeoutMs: timeoutMs,
    });
    return { ok: true, out: r.out, logs: r.logs };
  }

  throw new Error('未知子命令: ' + String(sub) + '（可用：status/pair/shell/forget）');
}

// 不用 process.exit()：对管道（Kotlin 读的是 pipe）stdout 写入是异步的，exit 可能截断结果行；
// 设 exitCode 让事件循环自然收尾，保证结果行完整落管道。
main()
  .then((res) => { process.stdout.write(RESULT_PREFIX + JSON.stringify(res) + '\n'); process.exitCode = 0; })
  .catch((err) => {
    process.stdout.write(RESULT_PREFIX + JSON.stringify({ ok: false, error: String((err && err.message) || err) }) + '\n');
    process.exitCode = 1;
  });
