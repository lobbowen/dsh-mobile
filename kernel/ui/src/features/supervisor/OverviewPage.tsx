/**
 * 控制面板（内核 overview）
 * 数据：supervisorStore /status（含 main 主干视图）+ /events 快照
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowUpRight, Power, RefreshCw, Rocket,
  ShieldCheck, TerminalSquare, Trash2, TriangleAlert,
} from "lucide-react";
import type { AdbStatus, NodeLtsStatus } from "../../services/supervisor";
import { toast } from "sonner";
import { Button } from "../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../../framework/ui/dialog";
import { formatClockTime } from "./format";
import { supervisorApi, useSupervisorData, type SupervisorEvent } from "../../services/supervisor";
import { Card, CardTitle, Metric, Pill, ToneDot } from "./widgets";
import { cn } from "../../framework/utils";
import { PortPanel } from "./PortPanel";
import { EVENT_LABELS, SUP_PHASE_META, friendlyFailure } from "./nav";
import { useSupervisorAction } from "./useSupervisorAction";

const NOISE = new Set(["dist_registry_selected", "lan_panel_changed"]);

/** 能力三态词表。null 一律显式写成「未知」，不许与「可用」同形也不许省略整行 ——
 *  空白在内核重启后与全通长得一样，那是第二种假绿。 */
const capWord = (ok: boolean | null): string => (ok === true ? "可用" : ok === false ? "不可用" : "未知");

export function OverviewPage() {
  const { snap } = useSupervisorData();
  const { busy, run } = useSupervisorAction();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  // main(原生 DSH) 守护开关（守护=跟开关走，默认关，持久化 dsh-main.json）
  const [mainGuardian, setMainGuardian] = useState<boolean | null>(null);
  const s = snap.status;
  const native = s?.native;
  const installed = native?.installed ?? false;
  const nstate = native?.state || (installed ? "installed" : "uninstalled");
  const installing = nstate === "installing";
  const uninstalling = nstate === "uninstalling";
  const nBusy = installing || uninstalling;
  const v = s?.version;
  const upg = s?.upgrade;
  const phaseMeta = SUP_PHASE_META[s?.phase ?? ""] ?? { label: s?.phase || "未知", tone: "off" as const };

  // ⚠ 已删除的能力（勿回潮）：「DSH Web」按钮（/instances/main/open-web）—— 服务端代开浏览器
  //   属 PC 桌面能力；安卓上 platform.os.browser.open() 无实现，面板改由容器 WebView 直接导航。
  //   2026-09-23：该「直接导航」的落点即下方 enterDsh() + 「进入 DSH」按钮（客户端跳
  //   window.top 到 /dsh/access 返回的回环 URL），与被删的「服务端代开」是两种能力。
  const running = Boolean(s?.dshPid);
  const upgradeRunning = upg?.state === "running";

  const events = useMemo(() => snap.events.filter((e) => !NOISE.has(e.type)), [snap.events]);

  async function toggleDsh() {
    // 2026-09：启停统一走 /lifecycle/dsh/start|stop（语义与旧 /start|/stop 等价，单一控制路径）
    await run("dsh", () => (running ? supervisorApi.lifecycleStop("dsh") : supervisorApi.lifecycleStart("dsh")), { success: running ? "正在停止 DSH…" : "正在启动 DSH…" });
  }
  async function checkUpdate() {
    // 检测完成后即时反馈：已是最新 / 发现新版（后端返回 updateAvailable + latest）
    await run("chk", async () => {
      const res = await supervisorApi.nativeCheckUpdate();
      if (res?.ok === false) { toast.error(res.error || "检测失败"); return; }
      if (res?.updateAvailable && res.latest) {
        toast.success("发现新版本 " + res.latest + (res.installed ? "（当前 " + res.installed + "），可一键升级" : ""));
      } else {
        toast.success("已是最新版本" + (res.installed ? "（" + res.installed + "）" : ""));
      }
    });
    // run 成功后 useSupervisorAction 已自动 refresh()；后端异步推进由 2s 统一心跳呈现（R6 修复：去除 1500ms 魔法时序）。
  }
  async function upgradeDsh() {
    setUpgradeOpen(false);
    await run("upg", () => supervisorApi.nativeUpgrade(), { success: "升级已开始，请耐心等待…" });
    // 升级为异步任务：状态机经 /status.upgrade 呈现，由 2s 轮询推进
  }
  async function enterDsh() {
    // 经 /dsh/access 取带令牌的回环直连 URL（令牌只回环下发）。容器 WebView 中面板嵌在
    // /__host 宿主帧 iframe 内 → 导航 window.top 整窗换页；浏览器直开时 top===self 语义一致。
    // 返回面板 = 重开 App（容器固定加载 /__host）。
    await run("enter", async () => {
      const r = await supervisorApi.dshAccess();
      if (!r?.ok || !r.url) throw new Error(r?.error || "未获得 DSH 访问地址");
      (window.top ?? window).location.href = r.url;
    }, { refresh: false });
  }
  async function installDsh() {
    if (!confirm("将在线安装最新版 DeepSeek Harness（需数分钟，自动适配最快镜像源）。确定继续？")) return;
    await run("inst", () => supervisorApi.nativeInstall(), { success: "开始安装 DeepSeek Harness…" });
  }
  async function uninstallDsh() {
    if (!confirm("将彻底卸载 DeepSeek Harness：删除全部文件、数据、缓存与日志，不留残留。确定继续？")) return;
    await run("uni", () => supervisorApi.nativeUninstall(), { success: "开始卸载…" });
  }

  // main 守护开关：读 /status 随快照下发的 main.guardian（dshMainView 持久化源，即时准确）——
  // 不走 /lifecycle/dsh（B 平面由心跳同步，打开后立即刷新会读到同步前旧值 = 开关弹回关）。
  useEffect(() => {
    const g = s?.main?.guardian;
    if (typeof g === "boolean") setMainGuardian(g);
  }, [s?.main?.guardian]);

  async function toggleMainGuardian() {
    // 按钮模式：点击翻转，消费后端返回值即时刷新
    const v = !(mainGuardian === true);
    await run("gu", () => supervisorApi.nativeSettings({ guardian: v }).then((r2) => {
      const g = r2?.main?.guardian;
      if (typeof g === "boolean") setMainGuardian(g);
      return r2;
    }), {
      success: v ? "已开启 DSH 进程守护（崩溃自动拉起）" : "已关闭 DSH 进程守护（崩溃后不再自动拉起）",
      refresh: false,
    });
  }

  const installedVer = installed ? (native?.version || v?.installed || "—") : "—";
  // null = 本轮还没跑过投放（不是"全部正常"），此时整行不渲染。
  const units = native?.nativeUnits ?? null;
  const caps = native?.nativeCaps ?? null;

  return (
    <div className="grid content-start gap-4">
      {/* 主状态卡 */}
      <Card>
        <div className="grid grid-cols-1 @min-[720px]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="flex flex-col gap-5 border-b border-border px-6 py-5 md:border-b-0 md:border-r">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-baseline gap-2">
                <h3 className="truncate text-xl font-semibold tracking-[-0.01em] text-foreground">DeepSeek Harness</h3>
                <span className="shrink-0 font-mono text-sm text-muted-foreground">v{installedVer}</span>
              </div>
              {busy === "chk" ? (
                <Button size="chip" disabled>
                  <RefreshCw className="size-3 animate-spin" />检测中…
                </Button>
              ) : v?.updateAvailable && v.latest ? (
                <Button className="text-primary-foreground" size="chip" onClick={() => setUpgradeOpen(true)}>
                  <ArrowUpRight className="size-3" />升级到 v{v.latest}
                </Button>
              ) : upgradeRunning ? (
                <Button size="chip" disabled>
                  <RefreshCw className="size-3 animate-spin" />升级中…
                </Button>
              ) : (
                <Button className="bg-primary/10 text-primary hover:bg-primary/15" onClick={() => void checkUpdate()} size="chip" variant="ghost">
                  <RefreshCw className="size-3" />检测更新
                </Button>
              )}
            </div>

            {nBusy ? (
              <div className="flex items-center gap-2">
                <ToneDot tone="boot" ping />
                <span className="text-base font-semibold leading-none text-foreground">
                  {installing ? "正在安装 DeepSeek Harness…" : "正在卸载 DeepSeek Harness…"}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <ToneDot tone={phaseMeta.tone} ping={phaseMeta.tone === "ok"} />
                <span className="text-base font-semibold leading-none text-foreground">{phaseMeta.label}</span>
              </div>
            )}

            {upgradeRunning && upg ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                正在升级（{upg.step || upg.targetVersion || ""}）…
              </div>
            ) : null}
            {upg?.state === "failed" ? (
              <p className="text-xs text-destructive">升级失败：{upg.lastError || "未知原因"}{upg.rolledBack ? "（已回滚）" : ""}</p>
            ) : null}

            {/* 原生安装进度日志 */}
            {nBusy && (native?.installLog ?? []).length ? (
              <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/70 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
                {(native?.installLog ?? []).slice(-6).join("\n")}
              </pre>
            ) : null}

            {/* 原生能力件的投放结局。为什么必须上屏：blocked 意味着"容器形态却缺前置"，
                真机 2026-09-26 的 glob/grep 全灭当时在界面上零痕迹 —— 缺件与"没跑过"
                合并显示就等于把缺口藏起来。PC 无此字段，整行不显示。 */}
            {units ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs leading-none text-muted-foreground">
                {Object.entries(units).map(([unit, o]) => (
                  <span key={unit} className={o.status === "blocked" || o.status === "failed" ? "text-destructive" : undefined}
                        title={o.reason || unit}>
                    {unit}·{o.status}
                  </span>
                ))}
              </div>
            ) : null}

            {/* 能力核验：与上面那排投放结局**正交**的第二个结论。上面说「我们动过手没有」，
                这一排才说「用户能不能用」。真机 2026-09-26 定罪：sharp-image 报 applied
                （@img/sharp-wasm32 逐字节在树内）而绑定取不到、read_image 全灭，界面零痕迹。
                有 units 而无 caps = 本轮没跑过探针，必须显式写出来（不显示=看着像全通）。 */}
            {caps ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs leading-none text-muted-foreground">
                <span className={caps.overall === false ? "font-semibold text-destructive" : undefined}
                      title="任一格不可用即整体不可用；没有红但有未知，整体就是未知">
                  能力{capWord(caps.overall)}
                </span>
                {Object.values(caps.units).map((c) => (
                  <span key={c.id} className={c.ok === false ? "text-destructive" : undefined} title={c.detail || c.id}>
                    {c.id}·{capWord(c.ok)}
                  </span>
                ))}
                {caps.note ? <span title={caps.note}>（{caps.note}）</span> : null}
                <span>核验于 {formatClockTime(caps.at)}</span>
              </div>
            ) : units ? (
              <div className="font-mono text-xs leading-none text-muted-foreground">
                能力未核验（本轮探针未执行，不等于可用）
              </div>
            ) : null}
          </div>

          <div className="flex items-center bg-[image:var(--panel-accent-gradient)] px-6 py-5">
            <div className="grid w-full grid-cols-2 gap-x-6 gap-y-4 @min-[560px]:grid-cols-4">
              <Metric icon={<Activity className="size-4" />} label="端口" value={s?.dshPort ? String(s.dshPort) : "—"} mono />
              <Metric icon={<TerminalSquare className="size-4" />} label="PID" value={s?.dshPid ? String(s.dshPid) : "—"} mono />
              <Metric icon={<RefreshCw className="size-4" />} label="重启次数" value={String(s?.restartCount ?? 0)} mono />
              <Metric icon={<ArrowUpRight className="size-4" />} label="最近故障" value={s?.lastFailure ? friendlyFailure(s?.lastFailure) : "无"} warn={Boolean(s?.lastFailure)} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-6 py-3">
          {/* 左：环境检测（Node 版本 + LTS 更新提示 + ADB 通道只读状态）——中屏以下(<980px 视口)隐藏, 位置让给右侧按钮 */}
          <div className="hidden lg:flex lg:items-center lg:gap-3">
            <EnvDetect />
            <AdbEnv />
          </div>
          {/* 右：安装/运行操作 + 分隔线 + 危险操作——ml-auto: 左信息隐藏(窄屏)时按钮组靠右对齐 */}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {!installed && !nBusy ? (
              <Button size="sm" disabled={busy === "inst"} onClick={() => void installDsh()}>
                <Rocket className="size-4" />安装 DSH
              </Button>
            ) : installed && !nBusy && !upgradeRunning ? (
              <>
                {/* D3-A 定案：主 DSH 由守卫统一自 spawn（始终守护拉起），无「进程守护」开关；
                    运行操作统一白底 outline（卸载 DSH 为唯一高危实色按钮） */}
                {/* 「进入 DSH」全断点可见（2026-09-23 真机：小屏无任何入口进不了 DSH）——
                    运行态主操作，primary 实色与 outline 运行操作区分 */}
                {running ? (
                  <Button disabled={busy === "enter"} onClick={() => void enterDsh()} size="sm">
                    <ArrowUpRight className="size-4" />进入 DSH
                  </Button>
                ) : null}
                <Button disabled={busy === "dsh"} onClick={() => void toggleDsh()} size="sm" variant="outline">
                  {running ? <><Power className="size-4 text-status-error" />停止 DSH</> : <><Rocket className="size-4 text-primary" />启动 DSH</>}
                </Button>
                {/* 分割线（自停止/启动 DSH 后开始分割）→ 进程守护按钮（按钮式，非 Switch） */}
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
                <Button className="h-[30px]" disabled={busy === "gu" || mainGuardian === null} onClick={() => void toggleMainGuardian()} size="sm" variant="outline">
                  <ShieldCheck className={cn("size-4", mainGuardian === true ? "text-status-ok" : "text-muted-foreground")} />
                  {mainGuardian === true ? "停止守护" : "启动守护"}
                </Button>
              </>
            ) : null}
            {installed && !nBusy ? (
              <>
                {/* 守护后无分割线(2026-09 用户定稿)——守护与危险操作直接相邻 */}
                <Button className="hidden h-[30px] md:inline-flex" disabled={busy === "uni"} onClick={() => void uninstallDsh()} size="sm" variant="destructive">
                  <Trash2 className="size-4" />卸载 DSH
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </Card>

      {/* 下端两栏（对齐环境变量左右结构）：左=事件日志（懒加载）/ 右=端口管理 */}
      <div className="grid items-start gap-4 @min-[860px]:grid-cols-[minmax(0,1fr)_420px]">
        <EventLogPanel events={events} />
        <PortPanel providers={snap.providers?.providers ?? []} />
      </div>

      {/* 升级确认弹窗 */}
      <Dialog open={upgradeOpen} onOpenChange={setUpgradeOpen}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader><DialogTitle>升级 DeepSeek Harness</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="flex items-center justify-center gap-3 rounded-md bg-muted px-4 py-3">
              <div className="text-center">
                <div className="text-xs text-muted-foreground">当前版本</div>
                <strong className="font-mono text-base text-foreground">{v?.installed || installedVer}</strong>
              </div>
              <ArrowUpRight className="size-4 text-muted-foreground" />
              <div className="text-center">
                <div className="text-xs text-muted-foreground">新版本</div>
                <strong className="font-mono text-base text-primary">{v?.latest || "—"}</strong>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              升级将先停止 DSH、安装新版本后自动拉起（需数分钟）。期间进行中的请求会中断，失败会自动回滚到当前版本。
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setUpgradeOpen(false)} variant="outline">取消</Button>
            <Button disabled={busy === "upg" || upgradeRunning} onClick={() => void upgradeDsh()}>
              {busy === "upg" || upgradeRunning ? "升级中…" : "开始升级"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 环境检测：当前 Node 版本 + 官方最新 LTS 更新提示（10 分钟轮询，静默失败降级） */
function EnvDetect() {
  const [node, setNode] = useState<NodeLtsStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await supervisorApi.nodeLts().catch(() => null);
      if (alive) setNode(r);
    };
    void load();
    const iv = setInterval(load, 10 * 60 * 1000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // 无数据（加载中）或失败且无当前版本时不渲染
  if (!node?.current) return <span className="min-w-[120px] text-xs text-muted-foreground">环境检测…</span>;

  // ⚠ 2026-09-13：改为消费后端**真实产出**的字段。
  //   原实现读 latestLts / updateAvailable / ltsName —— 后端（settings-view.js::nodeLtsStatus）
  //   从不产出这三个键（它不做远端查询），故「可更新到 vX LTS」整块是**不可达死分支**。
  //   现用 ltsLine（偶数主版本=通常为 LTS 线）给出真实提示，suggested 作 title 明细。
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="whitespace-nowrap" title={node.suggested || undefined}>环境检测 · Node v{node.current}</span>
      {node.ltsLine === false ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-warning-background px-2 py-0.5 font-semibold text-warning">
          <TriangleAlert className="size-3" />
          非 LTS 线（建议偶数主版本）
        </span>
      ) : node.ltsLine === true ? (
        <span className="hidden whitespace-nowrap text-muted-foreground/70 sm:inline">LTS 线</span>
      ) : null}
    </span>
  );
}

/**
 * ADB 通道环境状态（只读瓦片）：配对操作在容器 GUI 完成（ADR-0007），
 * 这里只呈现桥透传的结果。60s 轮询——配对态变化不频繁，太快是噪音。
 */
function AdbEnv() {
  const [st, setSt] = useState<AdbStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await supervisorApi.adbStatus().catch(() => null);
      if (alive) setSt(r);
    };
    void load();
    const iv = setInterval(load, 60 * 1000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (!st) return <span className="text-xs text-muted-foreground">ADB 检测…</span>;
  const tone: "ok" | "warn" | "off" = st.ok === false ? "off" : st.paired ? "ok" : "warn";
  const label = st.ok === false ? "ADB 桥不可用" : st.paired ? "ADB 已配对" : "ADB 未配对（去 App 配对）";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={st.paired ? `${st.host ?? ""}:${st.connectPort ?? ""}` : undefined}>
      <ToneDot tone={tone} />
      {label}
    </span>
  );
}

/** 事件日志（懒加载）：先渲染 15 条；滚到列表底部哨兵出现 → 继续 +15，直到全部事件渲染完。 */function EventLogPanel({ events }: { events: SupervisorEvent[] }) {
  const PAGE = 12;
  const [visible, setVisible] = useState(PAGE);
  const total = events.length;
  useEffect(() => { setVisible(PAGE); }, [events]);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((en) => en.isIntersecting)) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      setVisible((v) => Math.min(v + PAGE, total));
      setTimeout(() => { loadingRef.current = false; }, 80);
    }, { rootMargin: "120px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [total]);
  const shown = events.slice(0, visible);
  const hasMore = visible < total;
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardTitle title="事件日志" subtitle="核心运行状态遥测" actions={<span className="font-mono text-xs text-muted-foreground">{total}</span>} />
      {!total ? (
        <div className="px-5 py-6 text-center text-xs text-muted-foreground">暂无核心运行状态事件</div>
      ) : (
        <div className="flex max-h-[450px] min-h-0 flex-col overflow-y-auto overscroll-contain">
          {shown.map((e, i) => <EventRow key={e.seq ?? i} e={e} />)}
          <div ref={sentinelRef} className="px-5 py-2 text-center text-[11px] text-muted-foreground">
            {hasMore ? "下滑加载更多…" : "已加载全部"}
          </div>
        </div>
      )}
    </Card>
  );
}

function EventRow({ e }: { e: SupervisorEvent }) {
  const tone = EVENT_TONE[e.type] ?? "boot";
  const label = EVENT_LABELS[e.type] ?? e.type;
  const msg = eventDetail(e);
  return (
    <div className="grid min-w-0 grid-cols-[64px_auto_minmax(0,1fr)] items-center gap-2.5 border-b border-border/60 px-5 py-2 last:border-b-0 max-[640px]:grid-cols-[56px_auto_minmax(0,1fr)] max-[640px]:gap-2">
      <span className="text-xs tabular-nums text-muted-foreground">{formatClockTime(e.ts)}</span>
      <Pill tone={tone as "ok" | "err" | "warn" | "boot" | "off"}>{label}</Pill>
      <span className="truncate text-xs text-muted-foreground">{msg}</span>
    </div>
  );
}

/** 事件 → 人性化描述（对齐后端遥测语义；无匹配则空串 —— 标签已表达类型） */
function eventDetail(e: SupervisorEvent): string {
  const d = e.data;
  if (!d) return "";
  const fmt = (n: unknown) => Number(n ?? 0).toLocaleString("en-US");
  // 显式 message/reason 优先
  if (typeof d.message === "string") return d.message;
  if (typeof d.reason === "string") return friendlyFailure(d.reason);
  if (typeof d.desired === "string") return "期望 " + d.desired;
  // 路由遥测
  if (e.type === "router_usage") return (d.model || "") + (d.model ? " · " : "") + fmt(d.tokens) + " tokens";
  if (e.type === "router_pick") return [(d.provider || ""), (d.key || "")].filter(Boolean).join(" · ");
  if (e.type === "account_ready" || e.type === "account_frozen" || e.type === "account_banned" || e.type === "account_recovered" || e.type === "account_review" || e.type === "account_exhausted") {
    return (d.key || "") + (d.key ? " · " : "") + (d.provider || "");
  }
  if (e.type === "provider_quota_refreshed") return (d.provider || "") + " 额度已刷新";
  if (e.type === "proxy_update_available") return [(d.pkg || ""), (d.from || ""), (d.to || "")].filter(Boolean).join(" → ");
  if (e.type === "proxy_instance_started") return "port=" + (d.port ?? "") + (d.pid ? " pid=" + d.pid : "");
  // 守护开关变更 —— 写清对象 + 开/关
  if (e.type === "dsh_guardian_changed") {
    const who = d.name || (d.id === "main" ? "原生 DSH" : d.id || "目标");
    return who + " · 进程守护" + (d.enabled === true ? " → 开启" : " → 关闭");
  }
  // 通用指标字段拼装
  const parts: string[] = [];
  if (d.pid !== undefined) parts.push("pid=" + d.pid);
  if (d.port !== undefined) parts.push("port=" + String(d.port));
  if (d.version !== undefined) parts.push("v" + String(d.version));
  if (d.model && d.tokens !== undefined) parts.push(fmt(d.tokens) + " tok");
  if (d.ms !== undefined) parts.push(fmt(d.ms) + "ms");
  return parts.join(" · ");
}

/** 事件类型 → tone（覆盖：err 类红色、ok 类绿色、warn 黄、boot 蓝） */
const EVENT_TONE: Record<string, "ok" | "err" | "warn" | "boot" | "off"> = {
  running: "ok", adopted: "ok", spawned: "ok", main_instance_registered: "ok",
  upgrade_installed: "ok", upgrade_done: "ok", api_listening: "ok",
  account_ready: "ok", account_confirmed: "ok", account_recovered: "ok",
  proxy_instance_started: "ok", proxy_update_applied: "ok",
  router_provider_activated: "ok", router_provider_endpoint: "ok",
  plugin_install_done: "ok",
  native_installed: "ok", plugin_update_done: "ok",
  account_frozen: "err", account_banned: "err", dsh_exited: "err", unhealthy: "err",
  spawn_failed: "err", spawn_error: "err", upgrade_failed: "err", api_error: "err",
  proxy_instance_failed: "err",
  native_install_failed: "err", native_uninstall_failed: "err",
  plugin_install_job_failed: "err", plugin_update_job_failed: "err",
  plugin_uninstall_job_failed: "err", router_stream_aborted: "err",
  sigkill_sent: "err", start_timeout: "err", crash_loop_entered: "err",
  guard_exit: "warn", version_check_failed: "warn", restart_triggered: "warn",
  dsh_not_installed: "warn", sigterm_sent: "warn", account_review: "warn",
  // 配置/开关变更(黄 warn)——与运行状态绿、异常红、启动蓝区分
  dsh_guardian_changed: "warn",
  proxy_update_available: "warn", upgrade_started: "warn", upgrade_stopping_dsh: "warn",
  native_uninstall_started: "warn",
  account_discarded: "off", router_stopped: "off", proxy_instance_stopped: "off",
  plugin_uninstall_done: "off", native_uninstalled: "off",
  upgrade_skipped: "off", router_provider_deactivated: "off", stop: "off",
};
