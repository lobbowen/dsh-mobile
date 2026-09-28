/**
 * ============================================================================
 * console 宿主适配 — 统一出口
 * ============================================================================
 * 页面只需：
 *   import { consoleApi, useConsoleData, consoleStore } from "../services/console";
 * 数据契约见 types.ts；写操作经 consoleApi；运行态快照经 useConsoleData。
 *
 * 轮询生命周期：consoleStore.start() 只在 App 装配层启动一次（ConsoleApp），
 * 页面 hook 只订阅快照 —— 不重复启动（消灭"幂等兜底"式胶水）。
 * ============================================================================
 */
import { useSyncExternalStore } from "react";
import { consoleStore } from "./polling";

export * from "./types";
export type { ConsoleSnapshot } from "./polling";
export { consoleApi } from "./client";
export { consoleStore } from "./polling";
// 任务进度轮询（A2/A3 断点修复）：插件/反代 job 的「提交→轮询→终态」闭环。
export { pollJob } from "./jobs";
export type { JobState as PollJobState, PollJobOptions, PollJobResult } from "./jobs";

/**
 * 消费运行态快照（只订阅，不启动轮询 —— 启动由 App 装配层负责）。
 * 返回 { snap, refresh }。
 */
export function useConsoleData() {
  const snap = useSyncExternalStore(
    consoleStore.subscribe,
    () => consoleStore.snapshot,
    () => consoleStore.snapshot,
  );
  return { snap, refresh: consoleStore.refresh };
}
