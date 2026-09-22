/**
 * ============================================================================
 * supervisor HTTP API 客户端（同源 fetch，生产由 dsh-supervisor :3100 托管）
 * ============================================================================
 * - 唯一允许直接 fetch 的模块（页面通过 services 层间接使用）
 * - GET 纯读；写操作方法名后缀 Post/Action 显式标注
 * - 错误统一 throw Error（含后端 error/message）
 * - 生产同源（/…），开发跨端口用 vite proxy 转发（去掉 Origin 走回环）
 * ============================================================================
 */
import type {
  AccessKeyResult, AccessKeyStatus, EnvStatus, EventsPage, GenericOk,
  GuardVersion, InstalledPluginsResponse,
  LanPanelStatus, LifecycleModuleId, MarketResponse, NodeLtsStatus, PluginUpdatesResponse,
  MainInstance, PortsResponse, ProvidersResponse, RegistryInfo, RouterStatus,
  PluginJobStatus, ProxyUpdateStatus, SupervisorStatus, TasksResponse,
} from "./types";

// API 根（分体架构 + 动态端口 2026-09-07 定稿）：面板始终由守卫内核 HTTP 同源托管
// （壳 go_panel 按 config.apiPort 动态给 URL，页面与守卫 API 同源直连，无硬编码端口/无透传）。
const BASE = "";

/** 默认请求超时（R2 修复）：此前全部 fetch 无超时/无取消，后端挂起时按钮永久 busy。
 *  轮询 read 与本地写操作均应在该窗口内完成；慢网下由轮询层 in-flight 守卫兜底。 */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 长耗时端点的超时覆盖（如 proxyLoginWait 本身就是服务端轮询等待，需留足等待窗口） */
export const LONG_TIMEOUT_MS = 210_000;

export interface HttpOptions { timeoutMs?: number; }

/** AbortController 计时器：超时即 abort 并附可读错误；finally 里 clear 防泄漏 */
function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(new DOMException("请求超时", "TimeoutError")), ms);
  return { signal: c.signal, clear: () => clearTimeout(id) };
}

/** 统一错误提取：后端约定 {error|message}，缺省 HTTP 状态 */
async function http<T>(method: string, path: string, body?: unknown, opts?: HttpOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 同源/壳内直连 fetch（守卫托管同源或壳 asset 源走 CORS 白名单）；统一浏览器 fetch 路径
  const { signal, clear } = withTimeout(timeoutMs);
  const init: RequestInit = { method, headers: {}, signal };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${path}`, { cause: e });
    }
    throw e;
  } finally {
    clear();
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* 文本/空响应 */ }
  if (!res.ok) {
    const d = data as { error?: string; message?: string } | null;
    throw new Error(d?.error || d?.message || `HTTP ${res.status} ${path}`);
  }
  return data as T;
}
const get = <T>(p: string, opts?: HttpOptions) => http<T>("GET", p, undefined, opts);
const post = <T>(p: string, body?: unknown, opts?: HttpOptions) => http<T>("POST", p, body ?? {}, opts);

/** 文本端点（text/plain，如 /changelog、/guard/changelog）：http() 会尝试 JSON 解析失败后返回 null，
 *  故此处直接走 fetch 取原文（保持同源/CSP 与超时语义一致）。 */
async function getText(path: string): Promise<string> {
  const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, { method: "GET", signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return text;
  } finally { clear(); }
}

/** 查询参数拼接 */
function qs(base: string, params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? base + "?" + s : base;
}

export const supervisorApi = {
  // ── 运行态 ──
  status: () => get<SupervisorStatus>("/status"),
  // 注：/session/status 是容器（Android Service）与外部脚本的读取口；
  // UI 不发额外请求——会话态已随 /status（2s 轮询）以 sessionState 字段投影返回（避免双路径）。
  events: (after = 0, limit = 60) => get<EventsPage>(qs("/events", { after, limit })),
  routerStatus: () => get<RouterStatus>("/router/status"),
  providers: () => get<ProvidersResponse>("/router/providers"),
  tasks: () => get<TasksResponse>("/tasks"),
  ports: () => get<PortsResponse>("/ports"),
  // ── 统一生命周期（2026-09 归一化：模块启停/状态单一控制路径 /lifecycle/{id}/…，
  //    取代分散的 /start|/stop|/router/start|/router/stop —— 后端语义等价且 daemon 监督感知）──
  lifecycleStart: (id: LifecycleModuleId) => post<GenericOk & { ok?: boolean }>("/lifecycle/" + id + "/start"),
  lifecycleStop: (id: LifecycleModuleId) => post<GenericOk & { ok?: boolean }>("/lifecycle/" + id + "/stop"),
  // 注：GET /lifecycle/{id} 保留为后端 REST 面（单模块查询，供脚本/curl）；UI 未使用故不设 client 方法。

  // ── native DSH ──
  // DSH 访问入口：内核拼带令牌的回环直连 URL（令牌仅回环下发，非回环 403；未捕获令牌 409）
  dshAccess: () => get<GenericOk & { url?: string }>("/dsh/access"),
  // 后端返回 { ok, ...versionInfo() }（含 updateAvailable/latest/installed）；此前误标 GenericOk → 契约漏字段。
  nativeCheckUpdate: () => post<GenericOk & { updateAvailable?: boolean; latest?: string; installed?: string | null }>("/native/check-update"),
  nativeInstall: () => post<GenericOk>("/native/install"),
  nativeUpgrade: (version?: string) => post<GenericOk>("/native/upgrade", version ? { version } : {}),
  nativeUninstall: () => post<GenericOk>("/native/uninstall"),
  // 原生主干(main)设置：Android 内核白名单只有 guardian（守护自动拉起开关）
  nativeSettings: (patch: { guardian?: boolean }) =>
    post<GenericOk & { main?: MainInstance }>("/native/settings", patch),

  // ── router（模块启停已并入 /lifecycle/router/…；下方为供应商/账号管理端点）──
  providerAdd: (p: { name?: string; presetId?: string; kind?: string; appId?: string; keys?: string[] }) =>
    post<GenericOk & { id?: string }>("/router/providers/add", p),
  providerRemove: (id: string) => post<GenericOk>("/router/providers/remove", { id }),
  providerActivate: (id: string) => post<GenericOk>("/router/providers/activate", { id }),
  providerDeactivate: (id: string) => post<GenericOk>("/router/providers/deactivate", { id }),
  providerRefresh: (id: string) => post<GenericOk>("/router/providers/refresh", { id }),
  providerKeysSet: (id: string, p: { removeMasked?: string[]; add?: string[] }) =>
    // P2-5：新增 discarded/discardedKeys —— 后端如实回报被丢弃的 Key 及原因，
    //   UI 据此提示「N 个里 M 个失败」，不再一律报成功。
    post<GenericOk & {
      added?: number; removed?: number;
      discarded?: number; discardedKeys?: { key: string; error: string }[];
    }>("/router/providers/keys/set", { id, ...p }),
  providerKeyUse: (id: string, fingerprint: string) =>
    post<GenericOk & { active?: string }>("/router/providers/key/use", { id, fingerprint }),
  providerAccountConfirm: (id: string, keyId: string) => post<GenericOk>("/router/providers/account/confirm", { id, keyId }),
  providerAccountDiscard: (id: string, keyId: string) => post<GenericOk>("/router/providers/account/discard", { id, keyId }),
  proxyAddKey: (id: string, key: string) => post<GenericOk>("/router/providers/proxy/key", { id, key }),
  proxyRemoveKey: (id: string, keyId: string) => post<GenericOk>("/router/providers/proxy/key/remove", { id, keyId }),
  proxySelect: (id: string, keyId: string) => post<GenericOk>("/router/providers/proxy/select", { id, keyId }),
  proxyLoginStart: () => post<GenericOk & { authUrl?: string; waitMs?: number }>("/router/proxy/login/start"),
  // 服务端轮询等待（最长可 waitMs≈180s）：请求超时需覆盖等待窗口 + 网络余量
  proxyLoginWait: (timeoutMs: number) => post<GenericOk & { apiKey?: string }>("/router/proxy/login/wait", { timeoutMs }, { timeoutMs: Math.max(LONG_TIMEOUT_MS, timeoutMs + 30_000) }),
  proxyUpdateCheck: () => post<GenericOk>("/router/proxy/update/check"),
  proxyUpdateApply: (appId: string) => post<GenericOk>("/router/proxy/update/apply", { appId }),
  // 反代更新进度（后端注释承诺的「job 模型，前端轮询消除黑盒」）：多实例依次更新的进度可视化
  proxyUpdateStatus: (appId: string) => get<ProxyUpdateStatus>(qs("/router/proxy/update/status", { appId })),

  // ── plugins ──
  market: (force = false) => get<MarketResponse>("/plugins/market" + (force ? "?refresh=1" : "")),
  pluginsInstalled: () => get<InstalledPluginsResponse>("/plugins/installed"),
  pluginsCheckUpdates: (force = false) => get<PluginUpdatesResponse>("/plugins/check-updates" + (force ? "?refresh=1" : "")),
  pluginInstall: (spec: string, target: string) => post<GenericOk & { jobId?: string }>("/plugins/install", { spec, target }),
  pluginEnable: (name: string) => post<GenericOk>("/plugins/enable", { name, target: "all" }),
  pluginDisable: (name: string) => post<GenericOk>("/plugins/disable", { name, target: "all" }),
  pluginUpdate: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/update", { name, target: "all" }),
  pluginUninstall: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/uninstall", { name, target: "all" }),
  // 插件任务进度（job 模型）：install/update/uninstall 返回 jobId，前端轮询到 done/failed 消除黑盒
  pluginInstallStatus: (jobId: string) => get<PluginJobStatus>(qs("/plugins/install-status", { job: jobId })),

  // ── settings / env / guard / registry ──
  lanPanel: () => get<LanPanelStatus>("/settings/lan"),
  setLanPanel: (enabled: boolean) => post<GenericOk & LanPanelStatus>("/settings/lan", { enabled }),
  accessKey: () => get<AccessKeyStatus>("/settings/access-key"),
  setAccessKey: (key: string) => post<AccessKeyResult>("/settings/access-key", { key }),
  registry: () => get<RegistryInfo>("/dist/registry"),
  registrySet: (p: { mode: "auto" | "manual"; origins: string[]; manualOrigin?: string }) =>
    post<GenericOk & RegistryInfo>("/dist/registry/set", p),
  registryRefresh: () => post<GenericOk & RegistryInfo>("/dist/registry/refresh"),
  /** 同源单源探活（服务端探测，不受页面 CSP connect-src 'self' 约束）。
   *  ⚠ 2026-09-13：原先由浏览器直连用户填的镜像 → 被 CSP 拦截 → 恒报「探测失败」。 */
  registryProbe: (origin: string) => post<GenericOk & { origin: string; ok: boolean; latencyMs: number | null; probe?: string }>("/dist/registry/probe", { origin }),
  guardVersion: () => get<GuardVersion>("/guard/version"),
  /** 内核版本检查（源码形态走 git fetch 比对；安装由容器 OTA 执行，内核无写端点）。 */
  guardVersionCheck: () => post<GuardVersion & { ok?: boolean }>("/guard/version/check"),
  // 更新日志（A4 断点修复）：/changelog 返回 text/plain（DSH 版本信息 + 升级指引 + Releases 链接）。
  dshChangelog: () => getText("/changelog"),
  // 管家自身更新日志：本地 CHANGELOG.md 原文。
  guardChangelog: () => getText("/guard/changelog"),
  envStatus: () => get<EnvStatus>("/env/status"),
  nodeLts: () => get<NodeLtsStatus>("/env/node-lts"),
};
