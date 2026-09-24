'use strict';

// 内核 HostBridge 客户端 ←→ 容器 HostBridge 服务端 **真实 UDS 互通**测试。
//
// 目的：证明「内核能连上容器桥」这一关键接线成立（此前内核侧无任何桥客户端，桥是孤儿）。
// 用容器侧参考服务端（BridgeServer，真实暴露抽象命名空间 UDS）+ 内核侧真实客户端
// （dsh-android-kernel/src/platform/host-bridge/client.js），走完整链路：
//   连接 → bridge.handshake 能力协商 → 调用 8 组方法 → 能力门禁(-32001) / 未知方法(-32601)。
//
// 抽象命名空间 socket 名随机化，避免与真实设备 / 并行测试冲突。

const makeRunner = require('./harness');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { check, finish } = makeRunner('bridge-interop');

// ============================================================================
//  跨仓依赖：内核侧 HostBridge 客户端
// ============================================================================
//  本文件是**跨仓**测试 —— 它要的不是容器仓里的任何东西，而是内核仓的
//  `src/platform/host-bridge/client.js`。所以「内核仓在不在」直接决定它能不能跑。
//
//  原先这里写死了 `require('/workspace/dsh-android-kernel/src/...')`，后果是：
//  在**单仓 CI**（只 checkout 容器仓）上直接 `Cannot find module` 崩溃 ——
//  而崩溃发生在 require 的那一刻，连一条有用的断言都打不出来，
//  整个测试步骤红掉，看起来像"容器引擎有 bug"，实际是"隔壁仓不在"。
//
//  这是 3 小时发布构建上真实发生过的一次假红。正确做法：
//    · 路径可配置（env DSH_KERNEL_REPO），不写死绝对路径；
//    · 找不到就**显式 SKIP** 并说明"未验证什么"，让读者知道这次没验到什么。
//
//  注意：不能把 SKIP 做成静默通过 —— 跨仓互通是本项目最关键的接线之一，
//  "没验"和"验过了"在日志里必须能区分。所以 SKIP 时会把原因与补救方式打全。
// ============================================================================
// 单仓布局：内核就是仓内 dsh-android-kernel/ 子目录，默认路径直接按本文件位置算。
// DSH_KERNEL_REPO 仍可覆盖（跨仓试验 / fork）。
const KERNEL_REPO = process.env.DSH_KERNEL_REPO || path.join(__dirname, '..', '..', '..', 'kernel');
const CLIENT_REL = path.join('src', 'platform', 'host-bridge', 'client.js');
// 必须 path.resolve 而不是 path.join：env 给相对路径时（README 教的
// `DSH_KERNEL_REPO=../../dsh-android-kernel`），path.join 产出的仍是相对路径，
// 而 fs.existsSync 按 cwd 解析、require 按本测试文件所在目录解析 —— 两者
// 解析出不同目标，存在性检查过了、require 却 MODULE_NOT_FOUND 崩溃，
// 绕过了上面注释里立的"找不到必须显式 SKIP"契约。
const CLIENT_ABS = path.resolve(KERNEL_REPO, CLIENT_REL);

if (!fs.existsSync(CLIENT_ABS)) {
  console.log('SKIP 跨仓互通测试：找不到内核侧桥客户端');
  console.log('     期望路径: ' + CLIENT_ABS);
  console.log('     —— 未验证：内核客户端 ←→ 容器桥服务端的真实 UDS 互通');
  console.log('        （握手 / 能力协商 / 8 组方法调用 / -32001 与 -32601 门禁）。');
  console.log('     —— 这是**跨仓**测试，单仓 CI 上内核仓不在，属预期情况。');
  console.log('     —— 本地跑法：确认单仓子目录 dsh-android-kernel/ 存在，');
  console.log('        或设 DSH_KERNEL_REPO=<内核源码路径> 指过去。');
  console.log('     —— CI 若要跑它，需在 checkout 步骤额外拉内核仓并设置该环境变量。');
  finish();
}

const clientMod = require(CLIENT_ABS);
const { BridgeServer } = require('../src/bridge/server');


const SOCK = 'dsh_test_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const auditLog = path.join(os.tmpdir(), 'bridge-interop-audit-' + process.pid + '.log');

async function main() {
  // 容器侧：只有 base 能力（模拟未预置 device_owner/accessibility 的设备）
  const server = new BridgeServer({
    socketPath: '\0' + SOCK, // 抽象命名空间（与 Kotlin LocalServerSocket(name) 等价）
    deviceCapabilities: ['base'],
    auditLogPath: auditLog,
    storageRoot: path.join(os.tmpdir(), 'bridge-interop-store'),
  });
  await server.start();

  const c = new clientMod.HostBridgeClient({ socketName: SOCK, requires: ['bridge:app_control', 'bridge:device_policy'] });

  // 1) 连接 + 握手
  const hs = await c.handshake();
  check('内核客户端连上容器桥并完成握手', !!hs && hs.protocol === 1);
  check('握手返回设备能力（base）', Array.isArray(hs && hs.capabilities) && hs.capabilities.includes('base'));
  check('requires 含 device_policy 但设备无 device_owner → 未授予', Array.isArray(hs && hs.groups) && !hs.groups.includes('bridge:device_policy'));
  check('requires 含 app_control（代表能力 base）→ 已授予', hs && hs.groups.includes('bridge:app_control'));

  // 2) 调用 base 能力方法（应成功）
  const info = await c.call('sys.info', {});
  check('call sys.info 成功返回结果', !!info && info.ok === true && info.result && info.result.model === 'mock-android');

  const launch = await c.call('app.launch', { pkg: 'com.example.a' });
  check('call app.launch 成功', !!launch && launch.ok && launch.result.launched === 'com.example.a');

  const openUrl = await c.call('app.openUrl', { url: 'https://example.com' });
  check('call app.openUrl（browser 承接方）成功', !!openUrl && openUrl.ok && openUrl.result.opened === true);

  const post = await c.call('notif.post', { title: 't', text: 'b' });
  check('call notif.post（notify 承接方）成功', !!post && post.ok && post.result.posted === true);

  // app.stop 需 base 能力（非特权，不可审计）
  const stop = await c.call('app.stop', { pkg: 'com.example.a' });
  check('call app.stop 成功', !!stop && stop.ok && stop.result.stopped === 'com.example.a');

  // 3) 能力门禁：设备无 device_owner → policy.lockNow 返回 -32001
  const denied = await c.call('policy.lockNow', {});
  check('越能力调用 policy.lockNow → ERR_CAPABILITY_MISSING', !!denied && denied.ok === false && denied.error.code === -32001);

  // 4) 未知方法 → -32601
  const unknown = await c.call('nope.nothing', {});
  check('未知方法 → METHOD_NOT_FOUND', !!unknown && unknown.ok === false && unknown.error.code === -32601);

  // 5) 单例与 inContainer 判定
  check('inContainer 由 DSH_ANDROID 判定', clientMod.inContainer() === (process.env.DSH_ANDROID === '1'));

  // 6) 审计日志：握手必落盘；notif.post 已升格为审计方法（Kotlin MethodDef 基准）；
  //    非审计的 base 调用（app.launch）不得污染审计。
  let auditText = '';
  try { auditText = fs.readFileSync(auditLog, 'utf8'); } catch {}
  check('容器侧审计日志含 handshake', auditText.includes('handshake'));
  check('notif.post 写入审计', auditText.includes('"method":"notif.post"'));
  check('非审计调用（app.launch）未写入审计', !auditText.includes('"method":"app.launch"'));

  c.close();
  await server.stop();
  try { fs.unlinkSync(auditLog); } catch {}

  finish();
}

main().catch((e) => { console.error('interop 异常:', e && e.stack || e); finish(); });
