/**
 * 插件商店（supervisor plugins）— 市场（搜索/筛选/分页）+ 已装（启用/停用/更新/卸载）
 * ⚠ Android 内核只有「原生主干」一个安装目标：目标筛选/分组 UI 已随沙箱实例域删除。
 */
import { useEffect, useMemo, useState } from "react";
import { Package, Power, RefreshCw, Rocket, Search, Store, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../framework/ui/dialog";
import { Input } from "../../framework/ui/input";
import { formatSize } from "../../framework/format";
import {
  pollJob,
  supervisorApi,
  type InstalledPlugin, type MarketPlugin,
} from "../../services/supervisor";
import { useSupervisorAction } from "./useSupervisorAction";
import { Card, CardTitle, Pill } from "./widgets";
import { cn } from "../../framework/utils";

type Tab = "market" | "installed";
const PAGE = 24;

/** 批量 job 轮询汇总（A2 断点修复）：全部到终态后给出统一成败提示；无 jobId 时静默跳过。 */
async function pollJobsSummary(jobIds: string[], verb: string, total: number) {
  if (!jobIds.length) return;
  const t = toast.loading("正在" + verb + " " + total + " 个插件…（0/" + jobIds.length + "）");
  let done = 0, failed = 0;
  for (const id of jobIds) {
    const res = await pollJob(() => supervisorApi.pluginInstallStatus(id));
    if (res.state === "done") done++;
    else if (res.state === "failed") failed++;
    toast.loading("正在" + verb + " " + total + " 个插件…（" + (done + failed) + "/" + jobIds.length + "）", { id: t });
  }
  if (failed === 0) toast.success(verb + "完成（" + done + "/" + jobIds.length + "）", { id: t });
  else toast.warning(verb + "结束：成功 " + done + "，失败 " + failed, { id: t });
}

export function PluginsPage() {
  const [tab, setTab] = useState<Tab>("market");
  return (
    <div className="grid content-start gap-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(["market", "installed"] as const).map((t) => (
            <Button
              className={cn("font-medium", tab === t ? "bg-card text-foreground shadow-sm" : "bg-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground")}
              key={t}
              onClick={() => setTab(t)}
              size="sm"
              variant="ghost"
            >
              {t === "market" ? <Store className="size-3.5" /> : <Package className="size-3.5" />}
              {t === "market" ? "插件商店" : "已安装"}
            </Button>
          ))}
        </div>
        {tab === "market" ? <MarketRefresh /> : null}
      </div>
      {tab === "market" ? <MarketTab /> : <InstalledTab />}
    </div>
  );
}

function MarketRefresh() {
  const [refreshing, setRefreshing] = useState(false);
  async function go() {
    setRefreshing(true);
    try { await supervisorApi.market(true); toast.success("插件索引已刷新"); }
    catch (e) { toast.error(String(e)); }
    setRefreshing(false);
  }
  return (
    <Button disabled={refreshing} onClick={() => void go()} size="chip" variant="outline">
      <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />刷新
    </Button>
  );
}

function MarketTab() {
  const [index, setIndex] = useState<{ plugins: MarketPlugin[]; indexedAt?: string; sources?: Record<string, number> } | null>(null);
  const [kw, setKw] = useState("");
  // U1：Radix Select 值域 —— "all" 哨兵 = 全部（裸 <select> 的 "" 语义迁移）
  const [cat, setCat] = useState("all");
  const [src, setSrc] = useState("all");
  const [loaded, setLoaded] = useState(0);
  const [installTarget, setInstallTarget] = useState<MarketPlugin | null>(null);
  const [target, setTarget] = useState("native");

  useEffect(() => {
    let alive = true;
    supervisorApi.market().then((r) => { if (alive) { setIndex(r); setLoaded(PAGE); } }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    if (!index) return [];
    const q = kw.trim().toLowerCase();
    return index.plugins.filter((p) =>
      (cat === "all" || p.category === cat) &&
      (src === "all" || p.source === src) &&
      (!q || (p.name + " " + (p.description || "")).toLowerCase().includes(q)),
    );
  }, [index, kw, cat, src]);

  const cats = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of index?.plugins ?? []) m[p.category] = (m[p.category] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [index]);

  async function openInstall(p: MarketPlugin) {
    setInstallTarget(p);
    setTarget("native");
  }
  async function confirmInstall() {
    if (!installTarget) return;
    try {
      const r = await supervisorApi.pluginInstall(installTarget.name, target);
      if (r.ok === false) { toast.error(r.error || "安装失败"); return; }
      setInstallTarget(null);
      // A2 断点修复：后端返回 jobId 后**轮询到终态**（原先只提示「已提交」即止，无进度/成败反馈）
      if (r.jobId) {
        const t = toast.loading("正在安装 " + installTarget.name + "…");
        const res = await pollJob(() => supervisorApi.pluginInstallStatus(r.jobId as string));
        if (res.state === "done") toast.success("已安装 " + installTarget.name, { id: t });
        else if (res.state === "failed") toast.error("安装失败：" + (res.error || "未知原因"), { id: t });
        else toast.warning("安装仍在进行（超时未完成，可稍后查看）", { id: t });
      } else {
        toast.success("安装任务已提交");
      }
    } catch (e) { toast.error(String(e)); }
  }

  return (
    <div className="grid content-start gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="搜索插件名称、描述…" value={kw} onChange={(e) => setKw(e.target.value)} />
        </div>
        <Select value={cat} onValueChange={setCat}>
          <SelectTrigger className="h-9 w-[150px] shrink-0"><SelectValue placeholder="全部分类" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部分类</SelectItem>
            {cats.map(([c, n]) => <SelectItem key={c} value={c}>{c} ({n})</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={src} onValueChange={setSrc}>
          <SelectTrigger className="h-9 w-[130px] shrink-0"><SelectValue placeholder="全部来源" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部来源</SelectItem>
            <SelectItem value="npm">npm</SelectItem>
            <SelectItem value="github">GitHub</SelectItem>
            <SelectItem value="community">社区</SelectItem>
            <SelectItem value="official">官方</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!index ? (
        <div className="grid place-items-center py-20 text-sm text-muted-foreground">加载插件索引…</div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">共 {index.plugins.length} 个插件 · 更新 {index.indexedAt ? new Date(index.indexedAt).toLocaleString() : "—"} · npm {index.sources?.npm || 0} · GitHub {index.sources?.github || 0} · 社区 {index.sources?.community || 0}</p>
          {!filtered.length ? (
            <div className="grid place-items-center rounded-lg border border-dashed border-border py-16 text-sm text-muted-foreground">无匹配插件</div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2 @min-[1000px]:grid-cols-3">
                {filtered.slice(0, loaded).map((p) => (
                  <div key={p.name} className="flex min-h-[150px] flex-col rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-2">
                      <strong className="truncate font-mono text-sm text-foreground">{p.name}</strong>
                      <Pill tone={srcTone(p.source)}>{srcLabel(p.source)}</Pill>
                    </div>
                    <p className="mt-2 line-clamp-3 min-h-[36px] text-xs leading-relaxed text-muted-foreground">{p.description || "（无描述）"}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5">{p.category}</span>
                      {p.version ? <span className="font-mono">v{p.version}</span> : null}
                      {p.stars ? <span>⭐{p.stars}</span> : null}
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                      <span className="truncate text-xs text-muted-foreground">{p.author || ""}</span>
                      <Button onClick={() => void openInstall(p)} size="chip">安装</Button>
                    </div>
                  </div>
                ))}
              </div>
              {loaded < filtered.length ? (
                <Button className="justify-self-center" onClick={() => setLoaded((n) => n + PAGE)} variant="outline">加载更多（{loaded}/{filtered.length}）</Button>
              ) : null}
            </>
          )}
        </>
      )}

      {/* 安装目标选择 */}
      <Dialog open={!!installTarget} onOpenChange={(o) => !o && setInstallTarget(null)}>
        <DialogContent className="max-w-[400px]">
          <DialogHeader><DialogTitle>安装插件 — {installTarget?.name}</DialogTitle></DialogHeader>
          {/* Android 内核只有「原生主干」一个安装目标（沙箱实例域已删除）：无需目标选择 */}
          <p className="text-sm text-muted-foreground">安装目标：原生主干（native）</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setInstallTarget(null)} variant="outline">取消</Button>
            <Button onClick={() => void confirmInstall()}>开始安装</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const srcLabel = (s: string) => ({ npm: "npm", github: "GitHub", community: "社区", official: "官方" }[s] ?? s);
const srcTone = (s: string): "ok" | "err" | "warn" | "boot" | "off" => s === "official" ? "boot" : s === "npm" ? "ok" : s === "github" ? "warn" : "off";

/**
 * 已安装插件 —— 表格布局（对齐应用清理页：勾选 + 版本/大小/来源列）
 * 交互：逐行勾选；标题栏出现「更新所选(n)/卸载所选(n)」批量操作；
 *       「检查更新」检测后，有更新的行在版本列显示「可更新」徽标。
 */
function InstalledTab() {
  const [data, setData] = useState<{ inventoryReachable?: boolean; targets?: Array<{ id: string; name: string }>; thirdParty?: InstalledPlugin[] } | null>(null);
  // Android 内核只有原生主干一个安装目标：无目标筛选 UI，filter 恒为 all。
  const filter = "all";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updatable, setUpdatable] = useState<Map<string, string>>(new Map()); // name → 最新版
  const [checking, setChecking] = useState(false);
  const { busy, run } = useSupervisorAction();

  const load = async () => {
    const r = await supervisorApi.pluginsInstalled().catch(() => null);
    setData(r);
  };
  useEffect(() => { void load(); }, []);

  const list = data?.thirdParty ?? [];
  const pluginTargets = (p: InstalledPlugin) => (p.targets && p.targets.length ? p.targets : ["native"]);
  const shown = list.filter((p) => filter === "all" || pluginTargets(p).includes(filter));

  // 勾选操作
  const toggleOne = (name: string) => setSelected((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const allChecked = shown.length > 0 && shown.every((p) => selected.has(p.name));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(shown.map((p) => p.name)));
  const selRows = shown.filter((p) => selected.has(p.name));
  const hasUpdatableSel = selRows.some((p) => updatable.has(p.name));
  const stopSel = selRows.filter((p) => p.enabled);    // 可停止（当前启用）
  const startSel = selRows.filter((p) => !p.enabled); // 可启动（当前停用）

  async function checkUpdates() {
    setChecking(true);
    try {
      const r = await supervisorApi.pluginsCheckUpdates(true);
      const m = new Map<string, string>();
      for (const u of r.plugins ?? []) {
        if (!u.updateAvailable) continue;
        const latest = u.targets?.find((t) => t.latest)?.latest || "";
        m.set(u.name, latest);
      }
      setUpdatable(m);
      toast.success(m.size ? "发现 " + m.size + " 个可更新插件" : "全部插件已是最新");
      await load();
    } catch (e) { toast.error(String(e)); }
    setChecking(false);
  }
  async function updateSelected() {
    const names = selRows.filter((p) => updatable.has(p.name)).map((p) => p.name);
    if (!names.length) { toast.info("所选插件均无可用更新"); return; }
    setSelected(new Set());
    // 更新后这些插件不再是待更新项 → 从 updatable 移除（按钮回归「检查更新」态）
    setUpdatable((prev) => { const n = new Map(prev); for (const x of names) n.delete(x); return n; });
    await run("upd-sel", async () => {
      // A2 断点修复：收集 jobId 后**统一轮询到终态**（原先只提示「已提交」）
      const jobIds: string[] = [];
      for (const n of names) {
        try { const r = await supervisorApi.pluginUpdate(n); if (r.jobId) jobIds.push(r.jobId); } catch { /* 单点失败跳过 */ }
      }
      await pollJobsSummary(jobIds, "更新", names.length);
    }, { success: "已提交 " + names.length + " 个插件的更新任务", refresh: false, onDone: () => void load() });
  }
  async function uninstallSelected() {
    const names = selRows.map((p) => p.name);
    if (!confirm("将卸载所选 " + names.length + " 个插件：\n" + names.join("\n") + "\n\n确定继续？")) return;
    setSelected(new Set());
    await run("uni-sel", async () => {
      const jobIds: string[] = [];
      for (const n of names) {
        try { const r = await supervisorApi.pluginUninstall(n); if (r.jobId) jobIds.push(r.jobId); } catch { /* 单点失败跳过 */ }
      }
      await pollJobsSummary(jobIds, "卸载", names.length);
    }, { success: "已提交 " + names.length + " 个插件的卸载任务", refresh: false, onDone: () => void load() });
  }
  /** 批量停止（停用当前启用的所选插件） */
  async function stopSelected() {
    const names = stopSel.map((p) => p.name);
    setSelected(new Set());
    await run("stop-sel", async () => {
      for (const n of names) { try { await supervisorApi.pluginDisable(n); } catch { /* 单点失败跳过 */ } }
    }, { success: "已停止 " + names.length + " 个插件", refresh: false, onDone: () => void load() });
  }
  /** 批量启动（启用当前停用的所选插件） */
  async function startSelected() {
    const names = startSel.map((p) => p.name);
    setSelected(new Set());
    await run("start-sel", async () => {
      for (const n of names) { try { await supervisorApi.pluginEnable(n); } catch { /* 单点失败跳过 */ } }
    }, { success: "已启动 " + names.length + " 个插件", refresh: false, onDone: () => void load() });
  }

  const gridCols = "grid grid-cols-[88px_minmax(0,1fr)_120px_84px_36px] items-center gap-3";

  return (
    <Card className="overflow-hidden">
      {/* 标题栏（标题 + 右侧批量操作，对齐应用清理 PanelTitle） */}
      <CardTitle
        title={"已安装插件" + (data ? "（" + shown.length + "）" : "")}
        subtitle="原生主干（native）"
        actions={
          <>
            {/* 检测/更新合一（最前）：常态「检查更新」；勾选可更新项后演化「更新所选(n)」 */}
            {hasUpdatableSel ? (
              <Button disabled={busy === "upd-sel"} onClick={() => void updateSelected()} size="sm">
                <RefreshCw className="size-3.5" />更新（{selRows.filter((p) => updatable.has(p.name)).length}）
              </Button>
            ) : (
              <Button disabled={checking} onClick={() => void checkUpdates()} size="sm" variant="outline">
                <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
                {checking ? "检查中…" : "检查更新"}
              </Button>
            )}
            {selRows.length > 0 ? (
              <>
                {stopSel.length > 0 ? (
                  <Button disabled={busy === "stop-sel"} onClick={() => void stopSelected()} size="sm" variant="outline">
                    <Power className="size-3.5" />停用（{stopSel.length}）
                  </Button>
                ) : null}
                {startSel.length > 0 ? (
                  <Button disabled={busy === "start-sel"} onClick={() => void startSelected()} size="sm" variant="outline">
                    <Rocket className="size-3.5" />启动（{startSel.length}）
                  </Button>
                ) : null}
                <Button className="h-[30px]" disabled={busy === "uni-sel"} onClick={() => void uninstallSelected()} size="sm" variant="destructive">
                  <Trash2 className="size-3.5" />卸载（{selRows.length}）
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {!data ? <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
        : !shown.length ? <div className="grid place-items-center rounded-lg border-0 py-16 text-center"><Package className="mx-auto mb-3 size-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">当前未安装第三方插件</p></div>
        : (
          <>
            {/* 表头 + 行：窄容器下整体横向滚动（列宽保底不挤压） */}
            <div className="overflow-x-auto">
            <div className={cn(gridCols, "min-w-[720px] border-b border-border/70 bg-muted px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground")}>
              <span>来源</span>
              <span>插件</span>
              <span>版本</span>
              <span className="text-right">大小</span>
              <span className="flex justify-end"><Checkbox aria-label="全选" checked={allChecked} onChange={toggleAll} /></span>
            </div>
            {/* 行：整行可点选中（对齐应用清理：行内无独立按钮；操作统一在标题栏） */}
            <div className="max-h-[560px] overflow-auto">
              {shown.map((p) => {
                const checked = selected.has(p.name);
                const latest = updatable.get(p.name);
                return (
                  <label
                    key={p.name}
                    className={cn(
                      gridCols,
                      "min-h-[46px] min-w-[720px] w-full cursor-pointer border-b border-border/50 px-5 py-2 text-left transition-colors last:border-b-0 hover:bg-muted/40",
                      checked && "bg-muted/70 shadow-[inset_3px_0_0_var(--primary)]",
                    )}
                  >
                    {/* 来源 badge（首列，对齐原版管理源） */}
                    <span className="inline-flex w-fit min-w-0 items-center">
                      <Pill tone={p.bundle ? "boot" : p.source?.includes("github") ? "warn" : p.source === "npm" ? "ok" : "off"}>{p.bundle ? "bundle" : p.source === "npm" ? "npm" : p.source?.includes("github") ? "GitHub" : p.source && p.source !== p.name ? "本地" : "—"}</Pill>
                    </span>
                    {/* 插件名 + 描述 + 状态 */}
                    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                      <span className="grid min-w-0 gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <strong className="truncate font-mono text-[13px] font-semibold leading-tight text-foreground">{p.name}</strong>
                          <Pill tone={p.enabled ? "ok" : "off"}>{p.enabled ? "已启用" : "已停用"}</Pill>
                        </span>
                        {p.description ? <span className="truncate text-xs leading-tight text-muted-foreground">{p.description}</span> : null}
                      </span>
                    </span>
                    {/* 版本：有更新 → 徽标 */}
                    <span className="min-w-0">
                      {latest ? (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-xs text-muted-foreground">{p.version ? "v" + p.version : "—"}</span>
                          <Pill tone="warn">可更新</Pill>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{p.version ? "v" + p.version : "—"}</span>
                      )}
                    </span>
                    <span className="text-right font-mono text-xs tabular-nums text-foreground">{p.size ? formatSize(p.size) : "—"}</span>
                    <span className="flex justify-end"><Checkbox aria-label={"选择 " + p.name} checked={checked} onChange={() => toggleOne(p.name)} /></span>
                  </label>
                );
              })}
            </div>
            </div>
          </>
        )}
    </Card>
  );
}
