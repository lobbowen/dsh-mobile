/**
 * supervisor 功能域导航 — 5 域（Android 内核保留域）
 *
 * ⚠ 已删除的域（勿回潮）：实例管理（沙箱 instances）、远程控制（lan / relay / frpc）、
 *   桌面壳（Tauri shell）—— 对应端点与页面已整体删除，见 docs/components/kernel-android-plan.md §4。
 *   ADB 配对域（pairing）：写操作物理归 L0 容器 GUI（ADR-0007），面板仅 OverviewPage
 *   的只读环境状态瓦片。
 */
import {
  Activity, LayoutDashboard, ListChecks, Package, Settings,
  type LucideIcon,
} from "lucide-react";

export type SupervisorViewKey =
  | "overview" | "plugins" | "router" | "tasks" | "settings";

export const SUPERVISOR_NAV: Array<{
  key: SupervisorViewKey;
  label: string;
  icon: LucideIcon;
}> = [
  { key: "overview", label: "控制面板", icon: LayoutDashboard },
  { key: "plugins", label: "插件商店", icon: Package },
  { key: "router", label: "智能路由", icon: Activity },
  { key: "tasks", label: "任务中心", icon: ListChecks },
  { key: "settings", label: "设置", icon: Settings },
];

/** DSH phase 元数据（语义色 tone 对齐控制面板） */
export type Tone = "ok" | "warn" | "err" | "boot" | "off";
export const SUP_PHASE_META: Record<string, { label: string; tone: Tone }> = {
  RUNNING: { label: "运行中", tone: "ok" },
  STOPPED: { label: "已停止", tone: "off" },
  STARTING: { label: "启动中", tone: "boot" },
  RESTARTING: { label: "重启中", tone: "warn" },
  BACKOFF: { label: "退避中", tone: "err" },
  OBSERVED: { label: "运行中（未守护）", tone: "ok" },
};

/** 原生 DSH 生命周期 → 文本 + tone */
export function instancePhaseMeta(lp?: string, running?: boolean): { label: string; tone: Tone } {
  if (running) return { label: "运行中", tone: "ok" };
  if (lp === "INSTALLING") return { label: "安装中…", tone: "warn" };
  if (lp === "STARTING") return { label: "启动中…", tone: "boot" };
  if (lp === "BACKOFF") return { label: "重试中…", tone: "warn" };
  if (lp === "FAILED") return { label: "失败", tone: "err" };
  return { label: "已停止", tone: "off" };
}

/** 任务类型/动作/状态 中文 */
export const TASK_KIND_LABEL: Record<string, string> = {
  native: "原生 DSH", plugin: "插件", "proxy-app": "反代应用",
};
export const TASK_ACTION_LABEL: Record<string, string> = {
  install: "安装", upgrade: "升级", uninstall: "卸载", update: "更新",
};
export const TASK_STATE_META: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "排队中", tone: "warn" },
  running: { label: "进行中", tone: "boot" },
  succeeded: { label: "成功", tone: "ok" },
  failed: { label: "失败", tone: "err" },
  skipped: { label: "已跳过", tone: "off" },
  canceled: { label: "已取消", tone: "off" },
};

/** 最近故障 → 友好中文（对齐 FAILURE_META；绝不暴露内部码） */
const FAILURE_META: Record<string, string> = {
  manual: "手动重启", start_timeout: "启动超时", child_exit: "进程退出", adopted_exit: "进程退出",
  main_down: "原生实例未运行", spawn_error: "启动失败",
  spawn_failed: "启动失败", desired_stopped: "按需停止", upgrade: "升级停服",
  upgrade_hold: "升级中", upgrade_hold_timeout: "升级超时", died: "进程退出",
};
export function friendlyFailure(reason?: string | null): string {
  if (!reason) return "—";
  const r = String(reason);
  if (FAILURE_META[r]) return FAILURE_META[r];
  const mExit = /^exit:(.+)$/.exec(r);
  if (mExit) return /^sig/i.test(mExit[1]) ? "进程被终止" : "进程异常退出";
  if (/^spawn_error:/.test(r)) return "启动失败";
  return "异常";
}

/** 事件类型 → 中文标签（对齐后端发射全集；noise 已在 hook 过滤） */
export const EVENT_LABELS: Record<string, string> = {
  guard_started: "守卫启动", guard_exit: "守卫退出", desired_changed: "期望变更",
  spawn: "拉起", spawned: "已拉起", spawn_failed: "拉起失败", spawn_error: "拉起错误",
  dsh_command_missing: "命令缺失", dsh_not_installed: "DSH 未安装", dsh_exited: "DSH 退出",
  running: "运行中", adopted: "接管已运行进程", adopted_observed: "观测到运行进程",
  main_instance_registered: "主实例已注册", restart_triggered: "触发重启",
  sigterm_sent: "SIGTERM", sigkill_sent: "SIGKILL", stop: "停止", unhealthy: "不健康",
  start_timeout: "启动超时", crash_loop_entered: "进入退避",
  manual_restart_requested: "手动重启",
  api_listening: "API 监听", api_error: "API 错误", port_occupied_unhealthy: "端口被占",
  version_checked: "版本检查", version_check_failed: "检查失败",
  upgrade_started: "开始升级", upgrade_stopping_dsh: "停止以升级", upgrade_fresh_install: "全新安装",
  upgrade_installed: "安装完成", upgrade_skipped: "无需升级", upgrade_done: "升级完成",
  upgrade_failed: "升级失败", upgrade_rollback_started: "开始回滚", upgrade_rollback_failed: "回滚失败",
  upgrade_hold_timeout: "hold 超时",
  router_started: "中转启动", router_stopped: "中转停止", router_usage: "Token 消耗",
  router_pick: "路由选中", router_account_locked: "账号锁定", router_stream_aborted: "流式中断",
  provider_quota_refreshed: "额度已刷新", account_ready: "账号就绪", account_review: "账号待裁决",
  account_confirmed: "账号已入池", account_discarded: "账号作废", account_frozen: "账号冻结",
  account_banned: "账号封禁", account_recovered: "账号恢复", account_status: "账号状态变更",
  proxy_instance_started: "反代实例启动", proxy_instance_stopped: "反代实例停止",
  proxy_instance_failed: "反代实例失败", proxy_update_available: "反代有新版本",
  proxy_update_applied: "反代已更新", router_provider_activated: "供应商激活",
  router_provider_deactivated: "供应商停用", router_provider_endpoint: "独立端点上线",
  plugin_install_started: "插件安装开始", plugin_install_done: "插件安装完成",
  native_unit: "原生件投放",
  native_capability: "原生件能力核验",
  native_install_started: "DSH 安装开始", native_installed: "DSH 安装完成",
  native_install_failed: "DSH 安装失败", native_uninstall_started: "DSH 卸载开始",
  native_uninstalled: "DSH 卸载完成", native_uninstall_failed: "原生卸载失败",
  dsh_token_captured: "令牌捕获", stop_skipped_foreign_process: "跳过外部进程",
  dist_registry_unreachable: "镜像源不可达", plugin_install_job_failed: "插件安装失败",
  plugin_restart_started: "插件服务重启", plugin_restart_done: "插件服务重启完成",
  plugin_restart_failed: "插件服务重启失败", plugin_update_started: "插件更新开始",
  plugin_update_done: "插件更新完成", plugin_update_job_failed: "插件更新失败",
  plugin_uninstall_started: "插件卸载开始", plugin_uninstall_done: "插件卸载完成",
  plugin_uninstall_job_failed: "插件卸载失败",
  access_key_changed: "访问密钥变更", adopt_token_reclaim_started: "令牌回收重建",
  dist_registry_selected: "分发源选定", guardian_action: "守护接管动作",
  main_port_adopted: "主端口接管", orphan_audit: "游离进程审计",
  proxy_instance_hang_restart: "反代挂起重启", proxy_instance_log: "反代日志",
  proxy_instance_start_port_busy: "反代端口占用", proxy_instance_survivor_reclaimed: "残留反代回收",
  router_daemon_started: "中转守护启动", router_daemon_stopped: "中转守护停止",
  router_daemon_supervised: "中转守护接管", shadow_dsh_action: "影子状态同步",
  dsh_guardian_changed: "守护变更", guardian_off_exit: "未守护退出",
  lan_panel_changed: "局域网面板变更",
};
