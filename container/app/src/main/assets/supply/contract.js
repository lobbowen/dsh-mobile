"use strict";

// 自包含契约垫片（APK 侧共享层）。
//
// 为什么需要它：供给机制住在 APK 侧（C 是共享层，服务所有产品），它**不许**再 require 内核里的
//   平台模块（那样等于把机制绑回内核，换任何产品都要重来 —— 用户 2026-09-29 复核）。
//   所以由**容器在调用时把事实传进来**（它本来就是这些事实的写者）：
//     DSH_SUPPLY_PREFIX    $PREFIX 绝对路径
//     DSH_SUPPLY_NPM_ENTRY npm-cli.js 绝对路径（可缺）
//     DSH_SUPPLY_NODE_BIN  被检 node 可执行文件路径
// 缺失时如实返回 null / 空 —— 不伪造。

function read() {
  const prefix = process.env.DSH_SUPPLY_PREFIX || null;
  if (!prefix) return null;
  return {
    schema: 2,
    prefix,
    nodePath: process.env.DSH_SUPPLY_NODE_BIN || process.execPath,
    npmEntry: process.env.DSH_SUPPLY_NPM_ENTRY || null,
    npmPath: process.env.DSH_SUPPLY_NODE_BIN || process.execPath,
    minNode: null,
    writtenBy: 'container',
  };
}

function npmInvocation() {
  const node = process.env.DSH_SUPPLY_NODE_BIN || process.execPath;
  const entry = process.env.DSH_SUPPLY_NPM_ENTRY || null;
  return { bin: node, args: entry ? [entry] : [] };
}

function npmEnv(env) { return env; }

module.exports = { read, npmInvocation, npmEnv };
