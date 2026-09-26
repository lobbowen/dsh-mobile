/**
 * ============================================================================
 * supervisor 宿主 — 领域类型（对齐 dsh-supervisor HTTP API 实契约）
 * ============================================================================
 * 来源：src/presentation/api.js 全路由 + ui/（core.js / views-* / app.js）消费字段 + 线上抽样。
 * 只放纯数据类型，不含任何实现。
 * ============================================================================
 */

// ── /status ──────────────────────────────────────────────
export type DshPhase =
  | "RUNNING" | "STOPPED" | "STARTING" | "RESTARTING"
  | "BACKOFF" | "OBSERVED" | string;

export type NativeInstallState =
  | "uninstalled" | "installing" | "installed" | "uninstalling" | string;

/** 原生件投放单元的结局。skipped = 本就不该投（PC/无该依赖）；
 *  blocked = 容器形态却缺前置，是供给缺口；两者语义不同，UI 不许合并显示。 */
export type NativeUnitStatus = "applied" | "already" | "skipped" | "blocked" | "failed";

export interface NativeUnitOutcome {
  status: NativeUnitStatus;
  reason?: string | null;
  at?: string;
}

/** 能力核验三态。与投放结局正交：applied 只说明「我们动过手」，true 才说明「用户能用」。
 *  null = 探针没条件跑 / 判据待做 / 免检 —— **UI 绝不可把 null 渲染成通过**（真机 2026-09-26：
 *  sharp 报 applied 而绑定取不到，read_image 全灭）。 */
export interface NativeCapOutcome {
  id: string;
  ok: boolean | null;
  detail?: string | null;
  at?: string;
}

export interface NativeCapsReport {
  overall: boolean | null;
  units: Record<string, NativeCapOutcome>;
  /** 整批未执行的原因（非容器形态、根不可达、核验异常）。 */
  note?: string;
  at?: string;
}

export interface NativeDshStatus {
  installed: boolean;
  version?: string | null;
  binPath?: string | null;
  executable?: boolean;
  state?: NativeInstallState;
  installLog?: string[];
  lastInstall?: { version?: string; error?: string } | null;
  lastUninstall?: unknown;
  task?: unknown;
  /** 本轮进程的实际投放结局；null/缺席 = 本轮还没跑过（不是「全部正常」）。 */
  nativeUnits?: Record<string, NativeUnitOutcome> | null;
  /** 与 nativeUnits 必须同时读：那是第二个结论（能力通不通）。null = 本轮没核验过。 */
  nativeCaps?: NativeCapsReport | null;
}

export interface DshVersionInfo {
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
  lastCheckAt?: string | null;
  checking?: boolean;
  error?: string | null;
}

export type UpgradeStateName = "idle" | "running" | "done" | "failed" | "rolling_back" | string;
export interface UpgradeState {
  state: UpgradeStateName;
  step?: string | null;
  targetVersion?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  rolledBack?: boolean;
  logTail?: string[];
}

// 会话生命周期（契约 §3）：与 phase 正交——phase 是 main 状态机相位，
// sessionState 是整个服务链的运行相位（退出中/已退出）。
export type SessionState = "starting" | "running" | "stopping" | "stopped" | "failed" | string;

export interface SupervisorStatus {
  desired?: "running" | "stopped";
  phase?: DshPhase;
  sessionState?: SessionState;
  guardVersion?: string;
  /** 原生 DSH 主干视图（/status 随快照下发）：守护开关与运行态的唯一数据源。 */
  main?: MainInstance | null;
  dshPid?: number | null;
  dshPort?: number | null;
  adopted?: boolean;
  guardPid?: number;
  lastProbeAt?: string | null;
  lastProbeOk?: boolean;
  restartCount?: number;
  backoffLevel?: number;
  backoffUntil?: string | null;
  lastFailure?: string | null;
  upgradeHold?: boolean;
  commandMissing?: boolean;
  dshTokenCaptured?: boolean;
  native?: NativeDshStatus;
  version?: DshVersionInfo;
  upgrade?: UpgradeState;
  tasks?: unknown[];
  updatedAt?: string;
}

/** 原生 DSH 主干视图（后端 dshMainView()，随 /status 下发）。
 *  ⚠ 实例/沙箱域与远程控制字段（remoteEnabled/remoteToken/frpEnabled/frpRemotePort/wanPort）已删除。 */
export interface MainInstance {
  id: "main";
  name: string;
  port: number;
  command?: string[];
  domain: "native";
  kind?: string;
  /** 守护自动拉起开关（唯一可写字段，经 POST /native/settings { guardian }）。 */
  guardian: boolean;
  state?: { running?: boolean; phase?: string; pid?: number | null };
}

// ── /events ──────────────────────────────────────────────
export interface SupervisorEvent {
  seq?: number;
  type: string;
  ts: string;
  data?: {
    reason?: string;
    message?: string;
    pid?: number;
    desired?: string;
    model?: string;
    tokens?: number;
    key?: string;
    provider?: string;
    port?: number;
    version?: string;
    [k: string]: unknown;
  } | null;
}
export interface EventsPage { seq: number; events: SupervisorEvent[]; }

// ── /ports（端口注册表：对接后端的全部已注册端口）──
export interface PortRecord {
  port: number;
  role: string;
  owner: string | null;
  createdAt: number;
  /** 端口当前真实激活状态：正在监听=true（激活）；未监听=false（停用） */
  active?: boolean;
}
export interface PortsResponse { records?: PortRecord[]; }

// ── router ──────────────────────────────────────────────
export type ProviderKind = "direct" | "proxy";
export type AccountStatus =
  | "registering" | "review" | "frozen" | "banned" | "discarded" | "ready" | "normal" | string;
export interface QuotaWindow {
  status?: string;
  percent?: number;
  resetsAt?: string | number;
}
export interface AccountQuota {
  rolling?: QuotaWindow;
  weekly?: QuotaWindow;
  monthly?: QuotaWindow;
  monthlyRemaining?: number;
  /** 月额度随订阅续期重置时刻（epoch ms；Command /alpha/billing/subscriptions currentPeriodEnd 真实采样 2026-09）。 */
  monthlyResetAt?: number | null;
  /** Command /alpha/billing/credits 原体透传（真实采样 2026-09-04）：belowThreshold/creditThreshold 为上游低余额提醒 */
  credits?: {
    monthlyCredits?: number | null;
    purchasedCredits?: number | null;
    freeCredits?: number | null;
    belowThreshold?: boolean;
    creditThreshold?: number | null;
  } | null;
}
export interface ProviderAccount {
  keyId: string;
  maskedKey: string;
  status: AccountStatus;
  instanceStatus?: string;
  quota?: AccountQuota;
  quotaStatus?: string;
  usable?: boolean;
  /** 当前在用（= 显式锁定 或 自动在用 activeAccount）；账号行高亮依据 */
  selected?: boolean;
  /** 用户显式锁定（持久化 selectedAccountKeyId 指向本账号；区别于自动在用的 selected） */
  locked?: boolean;
  healthy?: boolean;
  requests?: number;
  totalTokens?: number;
  version?: string | null;
  updateAvailable?: boolean;
  registeredAt?: number;
  detectError?: string | null;
  nextResetAt?: number | null;
  /** 受限原因与恢复方式（window=到点恢复 / credits=充值后轮询恢复 / banned=人工复核） */
  limit?: {
    kind?: "window" | "credits" | "banned";
    since?: number;
    reason?: string | null;
    recovery?: { type?: "at" | "poll" | "manual"; at?: number | null; periodMs?: number | null } | null;
  } | null;
}
export interface RouterProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  proxyAppId?: string | null;
  activated?: boolean;
  active?: boolean;
  exhausted?: boolean;
  apiPort?: number;
  apiBase?: string;
  accounts?: ProviderAccount[];
  /** 持久化显式锁定账号（null=未手动锁，路由自动在用） */
  selectedAccountKeyId?: string | null;
  /** 显式锁定标志（区分自动在用） */
  locked?: boolean;
  /** 当前在用/锁定账号 keyId（列表/头部同源锚点） */
  activeKeyId?: string | null;
}
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl?: string;
  plan?: { per5hUsd?: number; weeklyUsd?: number; monthlyUsd?: number } | null;
  adapter?: unknown;
  pricing?: unknown;
  note?: string;
}
export interface ProxyAppInfo {
  id: string;
  name: string;
  registry?: unknown;
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
}
export interface RouterStatus {
  running: boolean;
  autostart?: boolean;
  // conflict?: boolean —— 已移除（后端从不产出，死字段；2026-09 审计）
  activatedProviders?: number;
  usage: {
    requests: number;
    errors: number;
    totalTokens: number;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number | null;
  };
  providers?: RouterProvider[];
}
export interface ProvidersResponse {
  presets?: ProviderPreset[];
  providers?: RouterProvider[];
  proxyApps?: ProxyAppInfo[];
}
// ── /tasks ──────────────────────────────────────────────
export type TaskKind = "native" | "plugin" | "proxy-app";
export type TaskAction = "install" | "upgrade" | "uninstall" | "update";
export type TaskState = "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled" | string;
export interface TaskStep { name: string; state: string; ts?: number; }
export interface TaskRecord {
  id: string;
  kind: TaskKind;
  action: TaskAction;
  target: { id?: string; name: string };
  from?: string | null;
  to?: string | null;
  state: TaskState;
  error?: string | null;
  steps?: TaskStep[];
  logTail?: string[];
  startedAt?: number;
  finishedAt?: number | null;
  createdBy?: string;
  meta?: Record<string, unknown>;
}
export interface TasksResponse { tasks: TaskRecord[]; current?: unknown; }

// ── plugins ─────────────────────────────────────────────
export type PluginSource = "npm" | "github" | "community" | "official";
export interface MarketPlugin {
  name: string;
  description?: string;
  source: PluginSource;
  category: string;
  version?: string;
  stars?: number;
  author?: string;
}
export interface MarketResponse {
  plugins: MarketPlugin[];
  indexedAt?: string;
  sources?: { npm?: number; github?: number; community?: number; official?: number };
}
export interface PluginTargetInfo { id: string; name: string; kind: string; }
export interface InstalledPlugin {
  name: string;
  version?: string;
  bundle?: boolean;
  source?: string;
  description?: string;
  enabled?: boolean;
  targets?: string[];
  targetNames?: string[];
  /** 插件目录体积（字节，后端统计首目标安装目录） */
  size?: number;
}
export interface InstalledPluginsResponse {
  ok?: boolean;
  inventoryReachable?: boolean;
  profile?: string;
  targets?: PluginTargetInfo[];
  rows?: unknown[];
  thirdParty?: InstalledPlugin[];
  builtinBundles?: Array<{ name: string; readonly?: boolean }>;
  installationOwned?: string[];
}
export interface PluginUpdatesResponse {
  plugins?: Array<{ name: string; updateAvailable?: boolean; targets?: Array<{ name: string; updateAvailable?: boolean; latest?: string }> }>;
  checkedAt?: string;
}
// 插件任务进度（后端 /plugins/install-status?job= 派生自 TaskRegistry；前端轮询到 done/failed）
export type JobState = "running" | "done" | "failed";
export interface PluginJobStatus {
  id?: string;
  kind?: string;
  name?: string;
  target?: string;
  state?: JobState;
  startedAt?: number | null;
  finishedAt?: number | null;
  error?: string | null;
  targets?: Array<{ name?: string; ok?: boolean; error?: string | null }>;
  error_?: never;
}
// 反代更新任务进度（/router/proxy/update/status；steps 逐实例，支持多实例依次更新可视化）
export interface ProxyUpdateStatus {
  state?: JobState;
  restarted?: number;
  errors?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  steps?: Array<{ name: string; state: string }>;
  taskId?: string;
  error?: string;
}
// ── settings / env / guard / registry ─────
export interface LanPanelStatus { enabled: boolean; host?: string; port?: number; urls?: string[]; }
export interface AccessKeyStatus { configured: boolean; host?: string; }
export interface AccessKeyResult extends AccessKeyStatus { ok: boolean; error?: string; }
export interface RegistryInfo {
  ok?: boolean;
  mode: "auto" | "manual";
  origin?: string;
  manual?: boolean;
  manualOrigin?: string;
  candidates?: Array<{ origin: string }>;
  presets?: Array<{ label: string; origin: string }>;
  latencyMs?: number;
  checkedAt?: number;
  probes?: Array<{ origin: string; ok: boolean; latencyMs: number }>;
}
export interface GuardVersion { version?: string; commit?: string; latest?: string; updateAvailable?: boolean; upstream?: string; }
// 平台能力矩阵（Android 固定档位，见 src/platform/os/index.js capabilityProfile）。
export interface PlatformCapabilities {
  platform?: string;
  arch?: string;
  /** 沙箱多实例（安卓内核无实例域，恒 false） */
  multiInstance?: boolean;
  /** 接管既有进程（端口/命令行反查 /proc） */
  pidAdoption?: boolean;
  /** 进程树终止（安卓由容器 / Android Service 管理，恒 false） */
  processTreeKill?: boolean;
  /** 桌面通知（内核无通知通道，经容器 HostBridge，恒 false） */
  desktopNotify?: boolean;
  /** 开机自启（归 APK 容器 / Android Service，恒 false） */
  autostart?: boolean;
  /** 公网暴露（远程控制域已删，恒 false） */
  frpExpose?: boolean;
  /** 宿主服务形态（安卓恒 'none'） */
  hostService?: string;
}
export interface EnvStatus {
  node?: { detected?: string; runtime?: string | null; path?: string | null };
  npm?: { detected?: string };
  git?: { detected?: string };
  ok?: boolean;
  catalog?: { ready?: boolean; items?: Record<string, { label: string; required?: boolean; state: string; detail?: string }> };
  capabilities?: PlatformCapabilities | null;
}
/** Node.js 环境检测（GET /env/node-lts）。
 *
 *  ⚠ 2026-09-13 修正契约（此前声明了后端**从不产出**的字段）：
 *    旧声明含 latestLts / ltsName / updateAvailable，而内核
 *    `guard/supervisor/settings-view.js::nodeLtsStatus()` **明确不做远端查询**
 *    （避免守卫启动依赖网络），实返只有 { ok, current, major, ltsLine, suggested,
 *    fetchedAt, cached }。于是前端那两个分支恒不可达、类型声明与实现分叉。
 *    现按真实返回对齐。若产品确需「官方最新 LTS」，应另开端点或改走壳 env_status 契约。 */
export interface NodeLtsStatus {
  ok: boolean;
  /** 当前系统 Node 版本（如 26.7.0） */
  current?: string | null;
  /** 当前主版本号 */
  major?: number | null;
  /** 当前主版本是否为偶数（本地保守判定「通常为 LTS 线」，非远端断言） */
  ltsLine?: boolean | null;
  /** 后端生成的展示建议（含是否 LTS 线的说明） */
  suggested?: string | null;
  /** 本次探测时刻（ms） */
  fetchedAt?: number | null;
  /** 是否命中 6h 磁盘缓存 */
  cached?: boolean;
  error?: string | null;
}

export interface GenericOk { ok?: boolean; error?: string | null; [k: string]: unknown; }

// ── /lifecycle（2026-09 归一化：统一生命周期 API）────────────────────────────
/** 生命周期模块 id（= 守卫 LifecycleManager 实际注册项，见 src/guard/lifecycle/adapters.js）。
 *  ⚠ 已删除的模块（勿回潮）：lan（远程控制）、instances（沙箱实例）。 */
export type LifecycleModuleId = "dsh" | "router" | "plugins";
export interface LifecycleModuleState {
  id: string;
  kind?: string;
  name?: string;
  phase: string;
  desired: string;
  healthy?: boolean;
  guardian?: boolean;
  monitoring?: boolean;
  error?: string | null;
  startedAt?: string | null;
  restartCount?: number;
  detail?: unknown;
}

// ── /adb（只读环境状态；配对/执行能力在 L0 容器，ADR-0007）──────────────────
export interface AdbStatus {
  ok?: boolean;
  keyPath: string;
  pubkey: string | null;
  paired: boolean;
  host: string | null;
  connectPort: number | null;
  guid: string | null;
  name: string | null;
  pairedAt: string | null;
}

