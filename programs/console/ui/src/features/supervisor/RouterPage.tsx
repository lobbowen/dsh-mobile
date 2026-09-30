/**
 * 智能路由（supervisor router + providers）
 * 顶部：路由启停 + 用量四卡；下方：供应商卡片（直连/反代统一行语义）+ 添加供应商
 */
import { useEffect, useState } from "react";
import {
  Activity, Ban, CheckCircle2, Copy, Plus, Power, RefreshCw, Repeat, Rocket, Terminal, Trash2, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../framework/ui/dialog";
import {
  pollJob, supervisorApi, supervisorStore, useSupervisorData,
  type ProviderAccount, type ProvidersResponse, type RouterProvider,
} from "../../services/supervisor";
import { formatCount } from "./format";
import { Card, Metric, Pill, QuotaBox, MonoEllipsis, ToneDot } from "./widgets";
import { useSupervisorAction } from "./useSupervisorAction";
import { cn } from "../../framework/utils";

/** 冻结/限额判定：任一窗口 rate-limited 或 ≥100% */
function quotaFull(q?: ProviderAccount["quota"]): boolean {
  if (!q) return false;
  const w = (x?: { status?: string; percent?: number }) => !!(x && (x.status === "rate-limited" || Number(x.percent) >= 100));
  return w(q.rolling) || w(q.weekly) || w(q.monthly);
}

/** epoch ms → 「YYYY/MM/DD HH:mm」本地时间（月度重置/恢复倒计时展示）。 */
function fmtClock(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 账号排序：当前使用(selected)最前 → 可用(usable 且非限额)其次 → 限额(rate-limited/冻结)排后。 */
function sortAccounts(accs: ProviderAccount[]): ProviderAccount[] {
  return [...accs].sort((a, b) => {
    const rank = (x: ProviderAccount) => x.selected ? 0 : (x.usable && !quotaFull(x.quota)) ? 1 : 2;
    return rank(a) - rank(b);
  });
}

/** 账号表网格列（完整字面量，Tailwind 需可静态扫描）。直连与反代统一：账号|用量|操作（无版本列）。 */
const accountGridCols = "grid-cols-[minmax(0,1fr)_230px_84px]";

export function RouterPage({ onRegisterActions }: { onRegisterActions?: (a: { onAdd: () => void; onDelete: () => void } | null) => void }) {
  const { snap } = useSupervisorData();
  const { busy, run } = useSupervisorAction();
  const [addOpen, setAddOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const r = snap.router;
  const pr = snap.providers;

  // 页级 Toolbar 动作注册：添加/删除供应商（对齐实例页机制）
  useEffect(() => {
    onRegisterActions?.({ onAdd: () => setAddOpen(true), onDelete: () => setDelOpen(true) });
    return () => onRegisterActions?.(null);
  }, [onRegisterActions]);

  /** 子组件动作回调：保持 (key, fn, success?) 签名，内部走共享 run */
  function act(key: string, fn: () => Promise<unknown>, success?: string) {
    return run(key, fn, { success });
  }

  const items = pr?.providers ?? [];
  return (
    <div className="grid content-start gap-4">
      {/* 路由状态卡 */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
          <div className="flex items-center gap-2">
            {/* conflict 分支移除（2026-09 审计）：后端 routerStatus/router.status 从不产出 conflict，
                原「端口被占」永不可达（死分支）。路由不可用由 running=false 呈现。 */}
            <ToneDot tone={r?.running ? "ok" : "off"} ping={Boolean(r?.running)} />
            <strong className="text-xl font-semibold tracking-[-0.01em] text-foreground">{r?.running ? "路由运行中" : "路由已停止"}</strong>
            {/* 路由服务默认自动启动(2026-09 用户定稿)——不额外外显「自动启动」标签 */}
          </div>
          <Button
            aria-label={r?.running ? "停止路由" : "启动路由"}
            className={cn("px-1", r?.running ? "text-status-error" : "text-primary")}
            disabled={busy === "sw"}
            onClick={() => void act("sw", () => (r?.running ? supervisorApi.lifecycleStop("router") : supervisorApi.lifecycleStart("router")), r?.running ? "路由已停止" : "路由已启动")}
            title={r?.running ? "停止路由" : "启动路由"}
            variant="ghost"
          >
            {r?.running ? <Power className="size-6" /> : <Rocket className="size-6" />}
          </Button>
        </div>
        {/* 运行指标：四格分隔（每格带边框与独立底） */}
        <div className="grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x lg:divide-border/60">
          {/* 后端降级响应（{running:false,error}）无 usage 字段：必须 usage?.，否则整页 TypeError（2026-09 修复） */}
          <div className="px-5 py-3.5"><Metric icon={<Activity className="size-4" />} label="总请求 / 失败" value={formatCount(r?.usage?.requests) + " / " + formatCount(r?.usage?.errors)} mono /></div>
          <div className="px-5 py-3.5"><Metric icon={<CheckCircle2 className="size-4" />} label="总 Tokens" value={formatCount(r?.usage?.totalTokens)} mono /></div>
          <div className="px-5 py-3.5"><Metric icon={<Terminal className="size-4" />} label="Prompt / Completion" value={formatCount(r?.usage?.promptTokens) + " / " + formatCount(r?.usage?.completionTokens)} mono /></div>
          <div className="px-5 py-3.5"><Metric icon={<XCircle className="size-4" />} label="估算费用" value={r?.usage?.costUsd ? "$" + Number(r.usage.costUsd).toFixed(4) : "—"} mono warn={!r?.usage?.costUsd} /></div>
        </div>
      </Card>

      {!items.length ? (
        <div className="grid min-h-[200px] place-items-center rounded-lg border border-dashed border-border text-center">
          <div>
            <Activity className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">尚未添加供应商</p>
            <p className="mt-1 text-xs text-muted-foreground">点击「添加供应商」录入 API Key / Command Code</p>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 @min-[900px]:grid-cols-2">
          {items.map((p) => (
            <ProviderCard key={p.id} p={p} proxyApps={pr?.proxyApps ?? []} busy={busy === p.id} onAction={act} />
          ))}
        </div>
      )}

      <AddProviderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        presets={pr?.presets ?? []}
        proxyApps={pr?.proxyApps ?? []}
        onDone={() => supervisorStore.refresh()}
      />
      <DeleteProviderDialog open={delOpen} onOpenChange={setDelOpen} providers={items} />
    </div>
  );
}

/** 删除供应商：列出全部供应商，选择删除（危险操作逐项确认）。 */
function DeleteProviderDialog({ open, onOpenChange, providers }: {
  open: boolean; onOpenChange: (o: boolean) => void; providers: RouterProvider[];
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  async function remove(p: RouterProvider) {
    if (!confirm("删除供应商「" + p.name + "」？其下全部账号与 Key 将被移除，不可恢复。")) return;
    setBusyId(p.id);
    try {
      await supervisorApi.providerRemove(p.id);
      toast.success("已删除供应商「" + p.name + "」");
      await supervisorStore.refresh();
    } catch (e) { toast.error(String(e)); }
    finally { setBusyId(null); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader><DialogTitle>删除供应商</DialogTitle></DialogHeader>
        <div className="grid gap-1.5">
          {providers.length ? providers.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/40 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <strong className="truncate text-sm font-medium text-foreground">{p.name}</strong>
                <span className="text-xs text-muted-foreground">{p.kind === "proxy" ? "反代" : "直连"} · {(p.accounts ?? []).length} 账号</span>
              </div>
              <Button disabled={busyId === p.id} onClick={() => void remove(p)} size="chip" variant="destructive">
                {busyId === p.id ? <RefreshCw className="size-3 animate-spin" /> : <Trash2 className="size-3" />}删除
              </Button>
            </div>
          )) : (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无供应商</p>
          )}
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={() => onOpenChange(false)} variant="outline">关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}



/** 供应商容器（清理记录式：标题栏 + 信息行/用量框 + 账号表） */
function ProviderCard({ p, proxyApps, busy, onAction }: {
  p: RouterProvider;
  proxyApps: ProvidersResponse["proxyApps"] | [];
  busy: boolean;
  onAction: (key: string, fn: () => Promise<unknown>, success?: string) => void;
}) {
  const accs = sortAccounts(p.accounts ?? []);
  const sel = accs.find((a) => a.selected) || accs.find((a) => a.usable && !quotaFull(a.quota)) || accs[0];
  const [editOpen, setEditOpen] = useState(false);
  // 反代应用级版本/更新信息（proxyAppId 匹配 proxyApps；可更新时标题栏出更新入口，更新该 app 全部实例）
  const appInfo = p.kind === "proxy" ? (proxyApps ?? []).find((a) => a.id === p.proxyAppId) ?? null : null;
  // API 地址死绑（不随启用/停用变化）：apiBase 缺失时按 apiPort 推导（停用态后端会清 apiBase，端口仍在）
  const apiBase = p.apiBase || (p.apiPort ? "http://127.0.0.1:" + p.apiPort + "/v1" : null);
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-muted px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <strong className="truncate text-sm font-semibold text-foreground">{p.name}</strong>
          {p.kind === "proxy" && appInfo && appInfo.installed ? (
            appInfo.updateAvailable ? (
              <Button
                className="gap-1 rounded-full px-2.5 text-xs text-warning"
                disabled={busy}
                onClick={() => void onAction("proxy-upd-" + p.id, async () => {
                  // A3 断点修复：后端注释承诺「job 模型，前端轮询消除黑盒」——此处补上轮询，
                  // 多实例依次更新期间显示进度（steps），到终态给出成败汇总。
                  const appId = p.proxyAppId as string;
                  const r = await supervisorApi.proxyUpdateApply(appId);
                  if (r.ok === false) { toast.error((r as { error?: string }).error || "提交失败"); return; }
                  const t = toast.loading("正在更新 " + p.name + " 的全部实例…");
                  const res = await pollJob(() => supervisorApi.proxyUpdateStatus(appId), {
                    onTick: (s) => {
                      const st = (s as { steps?: Array<{ state: string }> })?.steps || [];
                      const doneN = st.filter((x) => x.state === "done").length;
                      if (st.length) toast.loading("正在更新 " + p.name + "…（" + doneN + "/" + st.length + " 实例）", { id: t });
                    },
                  });
                  const snap = res.snapshot as { restarted?: number; errors?: number } | null;
                  if (res.state === "done") toast.success("更新完成" + (snap?.restarted ? "（已重启 " + snap.restarted + " 个实例）" : ""), { id: t });
                  else if (res.state === "failed") toast.error("更新失败：" + (res.error || (snap?.errors ? snap.errors + " 个实例失败" : "未知原因")), { id: t });
                  else toast.warning("更新仍在进行（超时未完成，可稍后查看）", { id: t });
                  await supervisorStore.refresh();
                }, undefined)}
                size="chip"
                title="检测到新版本，点击更新该应用全部实例"
                variant="outline"
              >
                <RefreshCw className="size-3" />更新 v{appInfo.latest}
              </Button>
            ) : (
              <Button
                className="gap-1 rounded-full px-2.5 text-xs font-mono text-muted-foreground"
                disabled={busy}
                onClick={() => {
                  // 检测后明确反馈：有更新 → 提示可点更新；无更新 → 已是最新（版本源为 npm/GitHub 镜像，与全局一致）
                  void onAction("proxy-chk-" + p.id, async () => {
                    const r = await supervisorApi.proxyUpdateCheck();
                    await supervisorStore.refresh();
                    if (!r.ok) { toast.error(r.error || "版本检测失败"); return; }
                    // versions: { appId: latest }，用当前 app 的结果比对已装版本
                    const latest = (r as { versions?: Record<string, string> }).versions?.[p.proxyAppId || ""] || null;
                    const installed = appInfo.installed;
                    toast.info(latest && latest !== installed
                      ? "发现新版本 v" + latest + "，点击版本胶囊更新"
                      : "已是最新版本 v" + installed);
                  }, undefined);
                }}
                size="chip"
                title="检测是否有新版本"
                variant="outline"
              >
                v{appInfo.installed}
                <RefreshCw className={cn("size-3", busy && "animate-spin")} />
              </Button>
            )
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button disabled={busy} onClick={() => setEditOpen(true)} size="sm" variant="outline">
            <Plus className="size-3.5" />添加
          </Button>
          {p.activated ? (
            <Button disabled={busy} onClick={() => void onAction("deact", () => supervisorApi.providerDeactivate(p.id).then(() => undefined), "已停用供应商（资源已回收）")} size="sm" variant="outline">
              <Power className="size-3.5" />停用
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void onAction("act", () => supervisorApi.providerActivate(p.id).then(() => undefined), "已启用供应商")} size="sm" variant="outline">
              <Rocket className="size-3.5" />启用
            </Button>
          )}
        </div>
      </div>

      {/* API 地址行：启用 → 显示真实地址 + 复制；未启用 → 占位提示（端口随启停可能变化，维持原联动逻辑） */}
      <div className="flex items-center gap-2 border-b border-border/60 px-5 py-2.5">
        <span className="text-xs text-muted-foreground">API 地址</span>
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card px-2.5">
          {p.activated && apiBase ? (
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{apiBase}</code>
          ) : (
            <span className="truncate text-xs text-muted-foreground/70">服务未启用</span>
          )}
        </div>
        {p.activated && apiBase ? (
          <Button
            onClick={() => void navigator.clipboard.writeText(apiBase || "").then(() => toast.success("已复制 API 地址"))}
            size="sm"
            title="复制该供应商 API 地址"
            variant="outline"
          >
            <Copy className="size-3.5" />复制
          </Button>
        ) : null}
      </div>

      {sel ? (
        <QuotaSummary acc={sel} busy={busy} p={p} onAction={onAction} />
      ) : (
        <div className="px-5 py-3 text-xs text-muted-foreground">暂无账号数据</div>
      )}

      {accs.length ? (
        <div className="flex min-h-0 flex-col border-t border-border/60">
          <div className={cn("grid items-center gap-2 border-b border-border/60 bg-muted/60 px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground", accountGridCols)}>
            <span>Key</span>
            <span className="text-center">用量</span>
            <span className="text-center">操作</span>
          </div>
          {/* 账号列表：容器内最多显示 6 行；超出部分容器内滚动（thin 半透明滚动条，滚动才随容器出现） */}
          <div className="max-h-[288px] min-h-0 overflow-y-auto overscroll-contain">
            {accs.map((a, i) => (
              <div key={a.keyId} className={cn(i > 0 && "border-t border-border/50")}>
                <AccountRow a={a} p={p} busy={busy} onAction={onAction} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">暂无 Keys — 点「添加」录入</p>
      )}
      <EditKeysDialog open={editOpen} onOpenChange={setEditOpen} p={p} />
    </Card>
  );
}

/** 编辑供应商：查看/移除已录入 Key + 添加新 API Key/账号（直连走 keys/set，反代走 proxy/key）。 */
function EditKeysDialog({ open, onOpenChange, p }: {
  open: boolean; onOpenChange: (o: boolean) => void; p: RouterProvider;
}) {
  const accs = p.accounts ?? [];
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const isProxy = p.kind === "proxy";
  /** 一键登录（仅反代 Command Code 类）：后端已调起浏览器，轮询等待回调拿到 Key 后自动加入。 */
  async function oneClickLogin() {
    setLoggingIn(true);
    try {
      const s = await supervisorApi.proxyLoginStart();
      if (!s.ok) { toast.error(s.error || "登录发起失败"); return; }
      toast.info("已打开浏览器，请在 Command Code 页面完成授权…", { duration: 4000 });
      const w = await supervisorApi.proxyLoginWait(s.waitMs ?? 180000);
      if (!w.ok || !w.apiKey) { toast.error(w.error || "登录未完成"); return; }
      await supervisorApi.proxyAddKey(p.id, w.apiKey);
      toast.success("已通过登录添加账号 " + (w.userName || w.keyName || ""));
      onOpenChange(false);
      await supervisorStore.refresh();
    } catch (e) { toast.error(String(e)); }
    finally { setLoggingIn(false); }
  }
  async function addKeys() {
    const keys = input.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean); // \s=空白（原 /[,;s]+/ 把字母 s 当分隔符，切碎含 s 的 Key）
    if (!keys.length) { toast.error("请输入至少一个 Key"); return; }
    setSaving(true);
    try {
      if (isProxy) {
        for (const k of keys) {
          const addRes = await supervisorApi.proxyAddKey(p.id, k) as { limited?: string; account?: { limit?: { recovery?: { type?: string; at?: number | null } | null } | null } | null } | null;
          // 检测后如实列示（2026-09）：月额度用尽的账号直接入库显示「月额度用尽」，无需 review/等待
          if (addRes && addRes.limited === "credits") {
            const rec = addRes.account?.limit?.recovery;
            toast.warning("已添加：该账号额度用尽" + (rec?.type === "at" && rec.at ? `（预计 ${fmtClock(rec.at)} 自动恢复）` : "（等待月度重置后自动恢复）"));
          }
        }
      } else {
        const r = await supervisorApi.providerKeysSet(p.id, { add: keys });
        if (r.ok === false) { toast.error(r.error || "添加失败"); return; }
        // ⚠ P2-5 修复（2026-09-12）：如实呈现**真实结果**，不再一律报 keys.length。
        //   此前无论后端丢弃多少个，这里都提示「已添加 N 个」——
        //   而 keys/set 过去根本不等检测结果（现已修），UI 也无从知道谁失败。
        const okN = typeof r.added === "number" ? r.added : keys.length;
        const badKeys = r.discardedKeys || [];
        if (badKeys.length) {
          const detail = badKeys.slice(0, 3).map((d) => `${d.key}（${d.error}）`).join("；");
          toast.warning(`已添加 ${okN} 个，${badKeys.length} 个失败被丢弃：${detail}${badKeys.length > 3 ? " …" : ""}`);
        } else {
          toast.success("已添加 " + okN + " 个 Key（" + (isProxy ? "反代账号" : "API Key") + "）");
        }
        setInput("");
        onOpenChange(false);
        await supervisorStore.refresh();
        return;
      }
      toast.success("已添加 " + keys.length + " 个 Key（" + (isProxy ? "反代账号" : "API Key") + "）");
      setInput("");
      onOpenChange(false);
      await supervisorStore.refresh();
    } catch (e) { toast.error(String(e)); }
    finally { setSaving(false); }
  }
  async function removeKey(masked: string) {
    if (!confirm("移除 Key " + masked + "？")) return;
    setSaving(true);
    try {
      if (isProxy) {
        // 反代: masked → 找 keyId
        const acc = accs.find((a) => a.maskedKey === masked || masked.startsWith(a.maskedKey));
        if (acc) await supervisorApi.proxyRemoveKey(p.id, acc.keyId);
      } else {
        const r = await supervisorApi.providerKeysSet(p.id, { removeMasked: [masked] });
        if (r.ok === false) { toast.error(r.error || "移除失败"); return; }
      }
      toast.success("已移除");
      onOpenChange(false);
      await supervisorStore.refresh();
    } catch (e) { toast.error(String(e)); }
    finally { setSaving(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader><DialogTitle>添加 / 管理 Key — {p.name}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          {/* 一键登录（反代专属：Command Code OAuth） */}
          {isProxy ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/40 px-3 py-2.5">
              <div className="grid gap-0.5">
                <span className="text-xs font-medium text-foreground">一键登录</span>
                <span className="text-[11px] leading-tight text-muted-foreground">浏览器打开 Command Code 授权，自动添加账号</span>
              </div>
              <Button disabled={loggingIn || saving} onClick={() => void oneClickLogin()} size="sm">
                {loggingIn ? "等待授权…" : "一键登录"}
              </Button>
            </div>
          ) : null}
          {/* 已录入 Keys */}
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{isProxy ? "已录入账号（反代）" : "已录入 API Key"}（{accs.length}）</span>
            {accs.length ? (
              <div className="grid max-h-[180px] gap-1 overflow-auto">
                {accs.map((a) => (
                  <div key={a.keyId} className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/40 px-2.5 py-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <code className="truncate font-mono text-xs">{a.maskedKey}</code>
                      {a.selected ? <Pill tone="ok">当前</Pill> : null}
                    </div>
                    <Button size="chip" variant="ghost" className="text-destructive" disabled={saving} onClick={() => void removeKey(a.maskedKey)} title="移除该 Key">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">尚未录入 {isProxy ? "账号" : "Key"}</p>
            )}
          </div>
          {/* 添加新 Key */}
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">添加 {isProxy ? "账号 Key / Command Code" : "API Key"}（每行一个，支持逗号/分号分隔）</Label>
            <Textarea
              className="h-20 resize-none font-mono text-xs"
              placeholder={isProxy ? "sk-... 或 Command Code，每行一个" : "sk-... 每行一个"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)} variant="outline">取消</Button>
          <Button disabled={saving || !input.trim()} onClick={() => void addKeys()}>{saving ? "保存中…" : "添加"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 信息行：左=当前账号；右=三个用量框（5小时/每周/每月） */
function QuotaSummary({ acc, busy, p, onAction }: { acc: ProviderAccount; busy: boolean; p: RouterProvider; onAction: (k: string, fn: () => Promise<unknown>, success?: string) => void }) {
  const q = acc.quota;
  const isActive = Boolean(acc.selected);
  const isLocked = Boolean(acc.locked);
  const qm = q && q.monthlyRemaining;
  // 每月用量展示（2026-09 修正，解析层已推导真实月用量）：Command 订阅含 $10/月配额池
  // （app.quota.monthlyCapUsd），解析层据 credits.monthlyRemaining 推导 monthly.percent（实测
  // $4.15 剩余 → 58%）。monthly.percent 存在 → 显示百分比；缺失才 fallback 金额/—。
  const mpct = q?.monthly?.percent;
  const monthlyValue = Number.isFinite(Number(mpct))
    ? mpct + "%"
    : (Number.isFinite(Number(qm)) ? "$ " + Number(qm).toFixed(2) : "—");
  return (
    <div className="flex flex-wrap items-center gap-4 px-5 py-3">
      <div className="grid min-w-[180px] content-center gap-1">
        <span className="text-xs text-muted-foreground">
          {isActive ? (isLocked ? "当前账号（锁定）" : "当前在用账号") : "选择账号"}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <MonoEllipsis className="max-w-[150px]">{acc.maskedKey}</MonoEllipsis>
          {isActive ? (
            <Button className="gap-1 px-2" disabled={busy} onClick={() => onAction("refresh", () => supervisorApi.providerRefresh(p.id).then(() => undefined), "额度已刷新")} size="chip" variant="outline">
              <RefreshCw className={cn("size-3", busy && "animate-spin")} />刷新
            </Button>
          ) : null}
        </div>
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-3 items-stretch gap-2">
        <QuotaBox icon={<RefreshCw className="size-3.5" />} label="5小时" value={(q?.rolling?.percent ?? 0) + "%"} danger={q?.rolling?.status === "rate-limited"} />
        <QuotaBox icon={<CheckCircle2 className="size-3.5" />} label="每周" value={(q?.weekly?.percent ?? 0) + "%"} danger={q?.weekly?.status === "rate-limited"} />
        <QuotaBox icon={<Activity className="size-3.5" />} label="每月" value={monthlyValue} danger={q?.monthly?.status === "rate-limited" || Number(q?.monthly?.percent ?? 0) >= 100} />
      </div>
    </div>
  );
}

function AccountRow({ a, p, busy, onAction }: { a: ProviderAccount; p: RouterProvider; busy: boolean; onAction: (key: string, fn: () => Promise<unknown>, success?: string) => void }) {
  const isActive = Boolean(a.selected);
  const status = a.instanceStatus === "frozen" ? "frozen" : a.status || "";
  // limited = 冻结 / 时间窗额度满 / 预付 credits 余额不足（limit.kind 驱动——避免把空余额 key 显示成可“切换”）
  const limitKind = a.limit?.kind;
  const limited = status === "frozen" || !!limitKind || (!isActive && quotaFull(a.quota));
  const limitHint = limitKind === "credits"
    ? (a.limit?.recovery?.type === "at" && a.limit?.recovery?.at
      ? `额度用尽（预计 ${fmtClock(a.limit.recovery.at)} 月度重置后自动恢复）`
      : "额度用尽（待月度重置后自动恢复）")
    : limitKind === "window" ? (a.limit?.reason ?? "时间窗额度已用尽（到 resetAt 自动恢复）")
    : limitKind === "banned" ? "账号被封禁" : null;
  const stats = formatCount(a.requests || 0) + " 次 · " + formatCount(a.totalTokens || 0) + " tok";
  const [quotaOpen, setQuotaOpen] = useState(false);
  let actionBtn: React.ReactNode;
  if (status === "review") {
    actionBtn = (
      <>
        <Button disabled={busy} onClick={() => void onAction("in", () => supervisorApi.providerAccountConfirm(p.id, a.keyId).then(() => undefined), "已入池")} size="chip" variant="outline">入池</Button>
        <Button className="h-[26px]" disabled={busy} onClick={() => void onAction("out", () => supervisorApi.providerAccountDiscard(p.id, a.keyId).then(() => undefined), "已作废")} size="chip" variant="destructive">作废</Button>
      </>
    );
  } else if (limited && !isActive) {
    actionBtn = (
      <Button size="chip" variant="outline" className="w-[70px] gap-1 px-1.5" onClick={() => setQuotaOpen(true)} title={limitHint ?? "查看该账号限额情况"}>
        <Ban className="size-3.5" />限额
      </Button>
    );
  } else if (isActive) {
    actionBtn = (
      <Button disabled={busy} onClick={() => onAction("refresh", () => supervisorApi.providerRefresh(p.id).then(() => undefined), "额度已刷新")} size="chip" variant="outline" className="w-[70px] gap-1 px-1.5">
        <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />刷新
      </Button>
    );
  } else {
    actionBtn = (
      <Button
        disabled={busy}
        size="chip"
        variant="outline"
        className="w-[70px] gap-1 px-1.5"
        onClick={() => {
          if (p.kind === "proxy") onAction("sel", () => supervisorApi.proxySelect(p.id, a.keyId).then(() => undefined), "已切换账号");
          else onAction("use", () => supervisorApi.providerKeyUse(p.id, a.keyId).then(() => undefined), "已锁定 Key");
        }}
      >
        <Repeat className="size-3.5" />切换
      </Button>
    );
  }
  return (
    <div className={cn("grid items-center gap-2 px-5 py-2.5 hover:bg-muted/40", accountGridCols, isActive && "bg-muted/60 shadow-[inset_3px_0_0_var(--primary)]")}>
      {/* 账号格：当前使用中的账号整行高亮（环境变量式：浅底 + 左主色条） */}
      <div className="flex min-w-0 items-center gap-1.5">
        <MonoEllipsis>{a.maskedKey}</MonoEllipsis>
        {status === "registering" ? <Pill tone="off">检测中…</Pill> : null}
        {status === "banned" ? <Pill tone="err">封号</Pill> : null}
        {limitKind === "credits" ? <span title={a.limit?.reason ?? "额度用尽"}><Pill tone="err">额度用尽</Pill></span> : null}
        {limitKind === "window" ? <span title={a.limit?.reason ?? "时间窗额度已用尽"}><Pill tone="warn">窗口用尽</Pill></span> : null}
      </div>
      {/* 用量格（加宽右对齐展示完整；表头与其右对齐一致） */}
      <span className="truncate text-right text-xs tabular-nums text-muted-foreground" title={stats}>{stats}</span>
      <div className="flex justify-end">{actionBtn}</div>
      <QuotaLimitDialog open={quotaOpen} onOpenChange={setQuotaOpen} a={a} p={p} />
    </div>
  );
}

/** 限额详情弹窗：展示该账号各窗口(5小时/每周/每月)的额度占用与重置时间。 */
function QuotaLimitDialog({ open, onOpenChange, a, p }: {
  open: boolean; onOpenChange: (o: boolean) => void; a: ProviderAccount; p: RouterProvider;
}) {
  const q = a.quota;
  // 每月用量磁贴（2026-09 修正）：顶部始终显示三格（5小时/每周/每月）——每月格子不因 monthly.percent
  // 是否为 null 而隐藏。Command 的 monthly.percent 由解析层从 credits.monthRemaining 推导（如 58%已用）；
  // 无推导值时用 credits 剩余兜底算 used% 或显示 0（保持三格布局稳定）。底部「每月额度（Command）」
  // 区块为补充金额详情（剩余 $X / $10），非替代格子。
  const monthlyUsed = (() => {
    const mp = q?.monthly?.percent;
    if (mp != null && Number.isFinite(Number(mp))) return Number(mp);
    const rem = Number(q?.credits?.monthlyCredits ?? q?.monthlyRemaining);
    const cap = 10; // Command $10/月订阅配额池
    if (Number.isFinite(rem) && rem >= 0 && cap > 0) return Math.min(100, Math.round(((cap - rem) / cap) * 100));
    return 0;
  })();
  const monthlyCell = (q?.monthly?.status ? { ...q.monthly, percent: monthlyUsed } : { status: "ok", percent: monthlyUsed, resetsAt: q?.monthly?.resetsAt });
  const monthlyRemainingText = (() => {
    const c = q?.credits?.monthlyCredits;
    const m = q?.monthlyRemaining;
    const rem = (c != null && Number.isFinite(Number(c))) ? Number(c) : (m != null && Number.isFinite(Number(m)) ? Number(m) : null);
    return rem !== null ? "剩余 $" + rem.toFixed(2) : null;
  })();
  const win = (w?: { status?: string; percent?: number; resetsAt?: string | number }, label?: string, amount?: string | null) => (
    <div className="grid gap-1 rounded-md border border-border/70 bg-muted/40 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <Pill tone={w?.status === "rate-limited" || Number(w?.percent) >= 100 ? "err" : "ok"}>
          {w?.status === "rate-limited" || Number(w?.percent) >= 100 ? "已限额" : "正常"}
        </Pill>
      </div>
      <strong className="text-xl font-semibold tabular-nums text-foreground">{w?.percent ?? 0}%</strong>
      {amount ? <span className="text-[11px] leading-tight text-muted-foreground">{amount}</span> : null}
      {w?.resetsAt ? <span className="text-[11px] leading-tight text-muted-foreground">重置：{new Date(w.resetsAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span> : null}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader><DialogTitle>限额详情</DialogTitle></DialogHeader>
        <div className="grid gap-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>账号</span><code className="font-mono">{a.maskedKey}</code>
            <span className="ml-auto text-xs">{p.name}</span>
          </div>
          {!q ? <p className="py-6 text-center text-sm text-muted-foreground">暂无额度数据 — 点「刷新」获取</p> : (
            <div className="grid grid-cols-3 gap-2">
              {win(q.rolling, "5小时")}
              {win(q.weekly, "每周")}
              {win(monthlyCell, "每月")}
              {(q.credits || q.monthlyRemaining != null) ? (
                <div className="col-span-3 flex flex-col gap-1 rounded-md border border-border/70 bg-muted/40 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">月度额度（Command）</span>
                    {q.credits?.belowThreshold ? <Pill tone="warn">低于充值线</Pill>
                      : (q.credits && Number.isFinite(Number(q.credits.monthlyCredits)) && Number(q.credits.monthlyCredits) <= 0) ? <Pill tone="err">额度用尽</Pill>
                      : <Pill tone="ok">正常</Pill>}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] leading-tight text-muted-foreground">
                      {Number(q.monthlyResetAt) > Date.now()
                        ? `月度额度预计 ${fmtClock(Number(q.monthlyResetAt))} 重置（随订阅续期）`
                        : `月度额度已于 ${fmtClock(Number(q.monthlyResetAt))} 重置`
                      }
                    </span>
                    {monthlyRemainingText ? (
                      <span className="text-sm font-semibold tabular-nums text-foreground">{monthlyRemainingText}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )}
          {q ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              当前用量统计：{formatCount(a.requests || 0)} 次请求 · {formatCount(a.totalTokens || 0)} tokens
              {q.monthly?.resetsAt ? "。最迟限额将于月窗口重置后自动解除。" : ""}
            </p>
          ) : null}
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={() => onOpenChange(false)} variant="outline">关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 添加供应商 Dialog（preset/proxy 选择） */
function AddProviderDialog({ open, onOpenChange, presets, proxyApps, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  presets: ProvidersResponse["presets"] | [];
  proxyApps: ProvidersResponse["proxyApps"] | [];
  onDone: () => void;
}) {
  const [presetId, setPresetId] = useState("");
  const [proxyId, setProxyId] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"preset" | "proxy">("preset");
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (mode === "preset" && !presetId) { toast.error("请选择供应商"); return; }
    if (mode === "proxy" && !proxyId) { toast.error("请选择反代应用"); return; }
    setSubmitting(true);
    try {
      const r = mode === "preset"
        ? await supervisorApi.providerAdd({ presetId, name: name || undefined, keys: [] })
        : await supervisorApi.providerAdd({ kind: "proxy", appId: proxyId, name: name || undefined, keys: [] });
      if (r.ok === false) { toast.error(r.error || "添加失败"); return; }
      toast.success("已添加供应商，请在卡片上点「添加」录入 Key");
      onOpenChange(false); setName(""); setPresetId(""); setProxyId("");
      onDone();
    } catch (e) { toast.error(String(e)); }
    finally { setSubmitting(false); }
  }
  const selectedPreset = (presets ?? []).find((p) => p.id === presetId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader><DialogTitle>添加供应商</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="flex gap-1.5 rounded-lg bg-muted p-1">
            {(["preset", "proxy"] as const).map((m) => (
              <Button
                className={cn("flex-1 rounded-md font-medium", mode === m ? "bg-card text-foreground shadow-sm" : "bg-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground")}
                key={m}
                onClick={() => setMode(m)}
                size="sm"
                variant="ghost"
              >{m === "preset" ? "直连预设" : "反代应用"}</Button>
            ))}
          </div>
          {mode === "preset" ? (
            <div className="grid gap-1.5">
              <Label>供应商</Label>
              <Select value={presetId} onValueChange={setPresetId}>
                <SelectTrigger className="w-full"><SelectValue placeholder="-- 选择供应商 --" /></SelectTrigger>
                <SelectContent>
                  {(presets ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {selectedPreset?.note ? <p className="text-xs leading-relaxed text-muted-foreground">{selectedPreset.note}</p> : null}
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label>反代应用</Label>
              <Select value={proxyId} onValueChange={setProxyId}>
                <SelectTrigger className="w-full"><SelectValue placeholder="-- 选择应用 --" /></SelectTrigger>
                <SelectContent>
                  {(proxyApps ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label>供应商名称（可选）</Label>
            <Input placeholder="自定义名称，如：Open Code ZEN" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">只添加供应商不填 Key；添加后在供应商卡片上点「添加」录入 API Key。</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)} variant="outline">取消</Button>
          <Button disabled={submitting} onClick={() => void submit()}>{submitting ? "添加中…" : "添加供应商"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
