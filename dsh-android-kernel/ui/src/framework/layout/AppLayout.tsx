import type { ReactNode } from "react";
import { cn } from "../utils";

/**
 * ============================================================================
 * DSH 通用 UI 框架 — AppLayout（响应式主布局）
 * ============================================================================
 * 侧边栏 + 主内容区。
 *
 * 响应式行为（现代自适应，不做上下堆叠）：
 *  - ≥641px：侧边栏为常驻左列，主内容占剩余轨道。
 *  - ≤640px：侧边栏变为 fixed 左侧抽屉（CSS 控制 transform 滑入/出），
 *    由 sidebarOpen 驱动；抽屉打开时渲染遮罩，点遮罩关闭。
 *    内容区始终独占主轨（grid 单列）。
 *
 * 用法：
 *   <AppLayout sidebarOpen={open} onCloseSidebar={close} sidebar={<AppSidebar/>}>
 *     <ContentArea>...</ContentArea>
 *   </AppLayout>
 * ============================================================================
 */

export type AppLayoutProps = {
  children: ReactNode;
  /** 侧边栏内容（null 时不渲染左侧栏） */
  sidebar?: ReactNode;
  /** 宽侧边栏模式（如空间分析） */
  wideSidebar?: boolean;
  /** 手机抽屉是否打开（≤640px 生效） */
  sidebarOpen?: boolean;
  /** 关闭抽屉回调（点遮罩 / 选完导航触发） */
  onCloseSidebar?: () => void;
  className?: string;
};

export function AppLayout({
  children,
  sidebar,
  wideSidebar = false,
  sidebarOpen = false,
  onCloseSidebar,
  className,
}: AppLayoutProps) {
  return (
    <div
      data-mode={wideSidebar ? "wide-sidebar" : "classic"}
      data-sidebar-open={sidebarOpen ? "true" : "false"}
      className={cn(
        "fw-layout grid h-full min-h-0 min-w-0 overflow-hidden bg-background max-[640px]:overflow-visible",
        className,
      )}
    >
      {sidebar}
      {children}
      {/* 手机抽屉遮罩：宽屏 display:none，不产生副作用 */}
      {sidebar && onCloseSidebar ? (
        <div
          aria-hidden="true"
          className="fw-drawer-scrim"
          onClick={onCloseSidebar}
        />
      ) : null}
    </div>
  );
}
