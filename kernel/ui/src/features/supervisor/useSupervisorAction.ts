/**
 * 共享动作 hook —— 统一页面写操作模式（消灭各页重复的 act()/busy）
 *
 * 模式：任一后端写操作 = setBusy(key) → await api → 成功 toast / 失败 toast → onDone/refresh
 *  - success：成功 toast 文案
 *  - refresh：是否刷新全局 supervisor 快照（默认 true）
 *  - onDone：页面级差异化后置动作（如重载本页列表），成功与失败后都会执行
 * 每页一个实例；key 用于按钮级忙碌态。
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { supervisorStore } from "../../services/supervisor";

export type ActionBusy = string | null;

export type RunOptions = {
  /** 成功 toast 文案 */
  success?: string;
  /** 是否刷新全局快照（默认 true；仅本页数据时置 false 并自管 onDone） */
  refresh?: boolean;
  /** 后置动作（无论成败），如重载页面列表 */
  onDone?: () => void;
};

export function useSupervisorAction() {
  const [busy, setBusy] = useState<ActionBusy>(null);

  const run = useCallback(async (
    key: string,
    fn: () => Promise<unknown>,
    opts?: RunOptions,
  ): Promise<boolean> => {
    setBusy(key);
    let ok = true;
    try {
      await fn();
      if (opts?.success) toast.success(opts.success);
    } catch (e) {
      ok = false;
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      opts?.onDone?.();
      if (ok && opts?.refresh !== false) supervisorStore.refresh();
    }
    return ok;
  }, []);

  return { busy, run };
}
