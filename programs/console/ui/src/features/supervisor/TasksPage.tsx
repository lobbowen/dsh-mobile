/**
 * 任务中心（supervisor）— 老 UI 任务中心域，统一安装/升级/卸载/更新任务状态与历史
 * 数据：GET /tasks（低频，进入页面时拉取 + 手动刷新）
 */
import { useEffect, useState } from "react";
import { ListChecks, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../framework/ui";
import { supervisorApi, type TaskRecord } from "../../services/supervisor";
import { TASK_ACTION_LABEL, TASK_KIND_LABEL, TASK_STATE_META } from "./nav";
import { formatDateTime } from "./format";
import { Card, Pill } from "./widgets";
import { cn } from "../../framework/utils";

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");

  async function load() {
    try {
      const r = await supervisorApi.tasks();
      setTasks(r.tasks);
    } catch (e) { toast.error(String(e)); }
  }
  useEffect(() => { void load(); }, []);
  async function refresh() {
    setRefreshing(true);
    try { await load(); toast.success("任务中心已刷新"); }
    catch { /* load 已 toast */ }
    finally { setRefreshing(false); }
  }

  const kinds = ["native", "instance", "plugin", "proxy-app"];
  const shown = (tasks ?? []).filter((t) => !filter || t.kind === filter);
  return (
    <div className="grid content-start gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button className={cn(!filter ? "bg-primary/10 text-primary hover:bg-primary/15" : "text-muted-foreground hover:bg-muted hover:text-foreground")} onClick={() => setFilter("")} size="sm" variant="ghost">全部</Button>
          {kinds.map((k) => (
            <Button className={cn(filter === k ? "bg-primary/10 text-primary hover:bg-primary/15" : "text-muted-foreground hover:bg-muted hover:text-foreground")} key={k} onClick={() => setFilter(k)} size="sm" variant="ghost">{TASK_KIND_LABEL[k] || k}</Button>
          ))}
        </div>
        <Button onClick={() => void refresh()} variant="outline"><RefreshCw className={cn("size-4", refreshing && "animate-spin")} />刷新</Button>
      </div>

      {!tasks ? (
        <div className="grid place-items-center py-16 text-sm text-muted-foreground">加载中…</div>
      ) : !shown.length ? (
        <div className="grid place-items-center rounded-lg border border-dashed border-border py-16 text-center">
          <ListChecks className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">暂无任务记录。安装 / 升级 / 卸载 / 更新操作完成后会在此显示状态与历史。</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {shown.map((t) => {
            const sm = TASK_STATE_META[t.state] || { label: t.state, tone: "off" as const };
            const ver = t.from && t.to && t.from !== t.to
              ? t.from + " → " + t.to
              : t.to ? "→ " + t.to : "";
            const steps = t.steps || [];
            return (
              <Card key={t.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{TASK_KIND_LABEL[t.kind] || t.kind}</span>
                    <Pill tone="boot">{TASK_ACTION_LABEL[t.action] || t.action}</Pill>
                    <strong className="truncate text-sm text-foreground">{t.target.name}</strong>
                    {ver ? <span className="font-mono text-xs text-muted-foreground">{ver}</span> : null}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Pill tone={sm.tone}>{sm.label}</Pill>
                    <span className="whitespace-nowrap">{formatDateTime(t.startedAt)}{t.finishedAt ? " ~ " + formatDateTime(t.finishedAt) : ""}</span>
                  </div>
                </div>
                {t.error ? <p className="mt-2 truncate text-xs text-destructive" title={t.error}>{t.error}</p> : null}
                {steps.length ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {steps.map((s, i) => (
                      <span key={i} className={cn(
                        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs leading-tight",
                        s.state === "done" && "bg-success-background text-success",
                        s.state === "running" && "bg-primary/10 text-primary",
                        s.state === "failed" && "bg-careful-background text-careful",
                        (!s.state || s.state === "pending") && "bg-muted text-muted-foreground",
                      )}>
                        {s.state === "running" ? <span className="size-1.5 animate-pulse rounded-full bg-primary" /> : null}
                        {s.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                {t.logTail?.length ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">日志（{t.logTail.length}）</summary>
                    <pre className="mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/70 p-3 font-mono text-xs leading-relaxed text-muted-foreground">{t.logTail.join("\n")}</pre>
                  </details>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
