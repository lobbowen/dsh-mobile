'use strict';

// ============================================================================
// ⚠ 测试夹具，不是生产链路（ADR-0006 / 架构收敛 C）。
//
// 真机上「装配环境 → spawn 内核」的**唯一权威**在 Kotlin 侧：
//   container/app/.../runtime/GuestAdapter.kt（装配契约）+ NodeRuntimeService.kt（执行）。
// 本文件曾是它的孪生实现，两侧靠注释互指、实际各写各的 —— TMPDIR/BRIDGE_SOCKET/
// PATH 都漂移过（漂移的后果是"只在真机复现"的静默断链）。
//
// 现在本文件只服务一个消费者：test/e2e-mock-kernel-test.js（桌面 CI 里用假 node
// 走通「OTA→切指针→spawn→健康检查」链路的集成测试）。键集与语义被
// test/boot-env-contract-test.js 逐条钉在 GuestAdapter 上：**这里新增任何
// GuestAdapter 没有的环境键 = CI 红**。要加键，先加到 GuestAdapter。
// ============================================================================
// 内核启动接线（测试夹具侧）。
// 读 CURRENT 指针 → 写 runtime.json → 注入 Android 环境 → spawn `node <kernel>/bin/dsh-supervisor daemon`
//   → 经内核 /status 健康检查。

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const { writeRuntimeJson } = require('../src/runtime-json');

/**
 * 拉起内核。返回 { child, kernelDir, entry }。
 * @param {object} o
 *  - kernelHome: DSH_SUPERVISOR_HOME（应用沙箱根）
 *  - kernelVersion: CURRENT 指向的版本
 *  - nodeBin: node 可执行文件绝对路径
 *  - nodeBinDir: node 所在目录（注入 PATH）
 *  - npmPath: npm 可执行绝对路径
 *  - npmEntry?: npm-cli.js 绝对路径（容器内嵌 npm 时投放，内核代跑）
 *  - uiDir?: 面板产物目录（默认 <kernel>/ui/dist）
 *  - cacheDir?: TMPDIR（生产恒 = cacheDir；桌面夹具缺省回落 os.tmpdir()，
 *               但键必须存在 —— 与 GuestAdapter.baseEnv 同构）
 *  - bridgeSocket?: HostBridge 抽象命名空间 socket 名（默认 dsh_hostbridge）
 *  - extraEnv?: 额外环境变量（= 生产侧的 L-D 垫片注入，夹具里由用例给）
 */
function bootKernel(o) {
  const kernelDir = path.join(o.kernelHome, 'kernel', o.kernelVersion);
  const entry = path.join(kernelDir, 'bin', 'dsh-supervisor');

  writeRuntimeJson({
    home: o.kernelHome,
    nodePath: o.nodeBin,
    nodeBinDir: o.nodeBinDir,
    npmPath: o.npmPath,
    npmEntry: o.npmEntry,
    writtenBy: 'android-node-container',
  });

  const env = Object.assign({}, process.env, {
    DSH_ANDROID: '1',
    DSH_PLATFORM: 'android',
    DSH_SUPERVISOR_HOME: o.kernelHome,
    DSH_UI_DIR: o.uiDir || path.join(kernelDir, 'ui', 'dist'),
    // HostBridge 抽象命名空间 socket 名（内核侧 client.js 用 '\0'+name 连接，
    // 与 GuestAdapter.BRIDGE_SOCKET / HostBridgeService.SOCKET_NAME 同一事实，
    // 由 boot-env-contract-test 钉死字面量）。
    DSH_BRIDGE_SOCKET: o.bridgeSocket || 'dsh_hostbridge',
    // PATH 组装次序与 GuestAdapter.kernelPlan 对齐：工具目录在前、node 目录其次、
    // 继承环境垫后（生产还有最前的 $PREFIX/bin，夹具里经 extraEnv 覆盖）。
    PATH: [o.nodeBinDir, process.env.PATH].filter(Boolean).join(path.delimiter),
    // NODE_PATH 双段（内核自带模块在前、共享安装目录其次）——同 GuestAdapter。
    NODE_PATH: [path.join(kernelDir, 'node_modules'), path.join(o.kernelHome, 'node_modules')]
      .join(path.delimiter),
    HOME: o.kernelHome,
    TMPDIR: o.cacheDir || os.tmpdir(),
  }, o.npmEntry ? { DSH_NPM_ENTRY: o.npmEntry } : {}, o.extraEnv || {});

  const child = spawn(o.nodeBin, [entry, 'daemon'], {
    env, cwd: kernelDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, kernelDir, entry };
}

/** 轮询内核健康检查端口，直到 200 或超时。 */
function pollHealth({ host, port, healthPath, timeoutMs }) {
  host = host || '127.0.0.1';
  healthPath = healthPath || '/status';
  timeoutMs = timeoutMs || 30000;
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const req = http.get({ host, port, path: healthPath, timeout: 800 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => { if (Date.now() < deadline) setTimeout(tick, 500); else resolve(false); });
      req.on('timeout', () => { req.destroy(); if (Date.now() < deadline) setTimeout(tick, 500); else resolve(false); });
    };
    tick();
  });
}

module.exports = { bootKernel, pollHealth };
