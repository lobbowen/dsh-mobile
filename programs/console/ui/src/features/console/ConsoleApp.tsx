/**
 * Console App（Android 面板控制面板宿主）
 * ============================================================================
 * 以面板 HTTP API（同源 http://127.0.0.1:<apiPort>）为后端的 5 域管理面板：
 *   AppShell(web) → AppLayout(sidebar) → Toolbar(页标题) → ContentArea(页) → StatusBar
 * 数据：consoleStore 统一 2s 轮询快照；页面只读消费 + 动作经 consoleApi。
 * 说明：这是 lobos-panel 的"管家面板"；skiff 清理工具 App 是另一个独立宿主，
 *       两者各自挂载（main.tsx 按宿主/路由选择）。
 * ============================================================================
 */
import { Component, lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AppShell, AppLayout, AppSidebar, Toolbar, ContentArea, StatusBar,
  type SidebarItem,
} from "../../framework/layout";
import { CheckCircle2, Menu } from "lucide-react";
import { Button } from "../../framework/ui";
import skiffLogo from "../../assets/lobos-logo.svg";
import { consoleStore, useConsoleData } from "../../services/console";
import { CONSOLE_NAV, type ConsoleViewKey } from "./nav";

// P1 修复：功能页面按需分包（React.lazy），首包不再包含全部页面体积。
// 具名导出经 .then(m => ({ default: m.X })) 适配 lazy 的 default 契约。
const OverviewPage = lazy(() => import("./OverviewPage").then((m) => ({ default: m.OverviewPage })));
const PluginsPage = lazy(() => import("./PluginsPage").then((m) => ({ default: m.PluginsPage })));
const TasksPage = lazy(() => import("./TasksPage").then((m) => ({ default: m.TasksPage })));
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })));
const PAGE_META: Record<ConsoleViewKey, { title: string; sub: string }> = {
  overview: { title: "控制面板", sub: "Agent Program 运行状态与升级" },
  plugins: { title: "插件商店", sub: "program 生态插件商店与已装管理" },
  tasks: { title: "任务中心", sub: "全部安装 / 升级 / 卸载 / 更新操作的任务状态与历史" },
  settings: { title: "设置", sub: "访问方式与关于" },
};

export function ConsoleApp() {
  const [view, setView] = useState<ConsoleViewKey>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { snap } = useConsoleData();
  const online = snap.online;
  const status = snap.status;

  // 轮询生命周期与宿主绑定（R3 修复）：start 只在装配层调用一次，卸载即 stop；
  // 兼容 React 19 StrictMode 开发双挂载（start→stop→start 幂等）。
  useEffect(() => {
    consoleStore.start();
    return () => consoleStore.stop();
  }, []);
  useEffect(() => { void consoleStore.refresh(); }, [view]);

  const closeSidebar = () => setSidebarOpen(false);
  const items = useMemo<SidebarItem[]>(() => CONSOLE_NAV.map((n) => ({
    key: n.key,
    label: n.label,
    icon: n.icon,
    active: view === n.key,
    onClick: () => { setView(n.key); setSidebarOpen(false); },
  })), [view]);

  const meta = PAGE_META[view];
  const phase = status?.phase;
  const sessionState = status?.sessionState;
  const running = Boolean(status?.programPid);

  // 面板由面板同源托管（浏览器 / 容器 WebView 打开同一地址），纯 web 内容铺满，不自绘窗口栏。
  return (
    <AppShell mode="classic">
      <AppLayout
        sidebarOpen={sidebarOpen}
        onCloseSidebar={closeSidebar}
        sidebar={
          <AppSidebar
            brand={{ logo: skiffLogo, title: "LOBOS", slogan: "Agent Program 管家" }}
            items={items}
          />
        }
      >
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <Toolbar
            title={meta.title}
            subtitle={meta.sub}
            menuButton={
              <Button
                aria-label="打开导航"
                className="shrink-0 text-foreground"
                onClick={() => setSidebarOpen(true)}
                size="sm"
                variant="outline"
              >
                <Menu className="size-4" />
              </Button>
            }
          />
          <ContentArea className="flex-1">
            <div className="min-w-0">
              <Suspense fallback={<PageFallback />}>
                <PageErrorBoundary key={view}>
                  {view === "overview" ? <OverviewPage /> : null}
                  {view === "plugins" ? <PluginsPage /> : null}
                  {view === "tasks" ? <TasksPage /> : null}
                  {view === "settings" ? <SettingsPage /> : null}
                </PageErrorBoundary>
              </Suspense>
            </div>
          </ContentArea>
          <StatusBar
            left={
              <>
                <CheckCircle2 className="size-3.5 text-muted-foreground" />
                <span className="font-mono text-xs leading-tight">{status?.guardVersion ?? "—"}</span>
              </>
            }
            right={
              // 会话生命周期优先（契约 §3，INV-S4）：stopping/stopped 时明确表达「退出中/已退出」——
              // 这是整个服务链的运行相位，比单看 main phase 更准确（退出中 main 可能已 STOPPED）。
              sessionState === "stopping" ? (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
                  管家正在退出（停止全部服务）…
                </span>
              ) : sessionState === "stopped" ? (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                  管家已退出（服务已全部停止）
                </span>
              ) : online && running ? (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-status-ok" />
                  Lob OS 管家运行中{phase ? " · " + phase : ""}
                </span>
              ) : online ? (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                  Lob OS 管家已停止{phase ? " · " + phase : ""}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-destructive" />
                  管家离线
                </span>
              )
            }
          />
        </section>
      </AppLayout>
    </AppShell>
  );
}

/** 分包页面加载占位：与全局 2s 快照无关的轻量骨架，避免整页空白闪烁 */
function PageFallback() {
  return (
    <div className="grid min-h-[320px] place-items-center" aria-busy="true" role="status">
      <div className="flex flex-col items-center gap-2">
        <span className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <span className="text-xs text-muted-foreground">加载中…</span>
      </div>
    </div>
  );
}

/** 页面级错误边界：lazy chunk 加载失败 / 页面运行时异常时兜底，不白屏（P1 配套） */
class PageErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[page] 渲染失败", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid min-h-[320px] place-items-center" role="alert">
          <div className="grid max-w-md justify-items-center gap-2 text-center">
            <strong className="text-sm font-semibold text-destructive">页面加载失败</strong>
            <p className="text-xs leading-relaxed text-muted-foreground">
              该页面组件未能加载。请刷新面板重试；若持续出现请联系排查。
            </p>
            <Button className="mt-1 h-8" size="sm" variant="outline" onClick={() => window.location.reload()}>
              刷新面板
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
