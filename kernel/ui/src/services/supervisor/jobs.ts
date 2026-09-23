/**
 * 任务（job）进度轮询——统一「提交 → 轮询 → 终态」闭环，消除黑盒等待。
 *
 * 背景（功能断点审计 A2/A3）：后端插件安装/更新/卸载与反代更新均实现了 job 模型
 * （返回 jobId，并提供 status 端点派生 running/done/failed），但前端提交后不轮询，
 * 用户只看到「任务已提交」而无进度与成败反馈。本模块统一补上该闭环。
 *
 * 设计：纯函数式轮询器（不依赖 React），便于在 action 内 await，也便于单测。
 */

export type JobState = "running" | "done" | "failed";

export interface PollJobOptions {
  /** 轮询间隔（默认 1200ms；插件安装耗时数秒~数分钟） */
  intervalMs?: number;
  /** 总超时（默认 10 分钟；超时返回最后一次快照并标记 timedOut） */
  timeoutMs?: number;
  /** 每次成功取到快照时回调（UI 可据此更新进度文案） */
  onTick?: (snap: unknown) => void;
  /** 中止信号（组件卸载/用户取消） */
  signal?: { aborted: boolean };
}

export interface PollJobResult<T> {
  state: JobState;
  snapshot: T | null;
  /** 超时未达终态（仍为 running） */
  timedOut?: boolean;
  error?: string | null;
}

function readState(snap: unknown): JobState | null {
  if (!snap || typeof snap !== "object") return null;
  const s = (snap as { state?: unknown }).state;
  if (s === "done" || s === "failed" || s === "running") return s;
  return null;
}

/**
 * 轮询任务直到 done/failed（或超时/中止）。
 * @param fetchStatus 取状态快照（如 supervisorApi.pluginInstallStatus(jobId)）
 */
export async function pollJob<T>(
  fetchStatus: () => Promise<T>,
  opts: PollJobOptions = {},
): Promise<PollJobResult<T>> {
  const intervalMs = Math.max(300, opts.intervalMs ?? 1200);
  const timeoutMs = Math.max(intervalMs, opts.timeoutMs ?? 10 * 60 * 1000);
  const started = Date.now();
  let last: T | null = null;
  for (;;) {
    if (opts.signal?.aborted) return { state: "running", snapshot: last, error: "已取消" };
    try {
      const snap = await fetchStatus();
      last = snap;
      if (opts.onTick) { try { opts.onTick(snap); } catch { /* UI 回调异常不影响轮询 */ } }
      const st = readState(snap);
      if (st === "done") return { state: "done", snapshot: snap, error: null };
      if (st === "failed") {
        const err = (snap as { error?: string | null } | null)?.error ?? null;
        return { state: "failed", snapshot: snap, error: err };
      }
      // 后端返回 { error: 'job not found' }：视为终态失败（避免无限轮询）
      const rawErr = (snap as { error?: unknown } | null)?.error;
      if (rawErr && st === null) {
        return { state: "failed", snapshot: snap, error: String(rawErr) };
      }
    } catch {
      // 单次查询失败（网络抖动/守卫重启）：继续重试直到超时
    }
    if (Date.now() - started >= timeoutMs) {
      return { state: "running", snapshot: last, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
