import type { ReactNode } from "react";
import { cn } from "../utils";

/**
 * ============================================================================
 * DSH 通用 UI 框架 — AppShell（应用外壳）
 * ============================================================================
 * 应用最外层容器：纯网页布局容器（铺满视口，无任何窗口外观）。
 *
 * 分层架构：面板由内核同源托管、运行于安卓容器 WebView / 手机浏览器，
 * 本组件只是**纯网页布局容器**（铺满视口），不含任何窗口外观/拖动逻辑。
 * ============================================================================
 */

export type AppShellProps = {
  children: ReactNode;
  /** 布局模式：classic（标准侧边栏）/ wide-sidebar（宽侧边栏，如空间分析） */
  mode?: "classic" | "wide-sidebar";
  className?: string;
};

export function AppShell({ children, mode = "classic", className }: AppShellProps) {
  return (
    <main
      data-mode={mode}
      data-host="web"
      className={cn(
        "fw-shell grid h-full w-full overflow-hidden max-[640px]:h-auto max-[640px]:min-h-dvh max-[640px]:overflow-x-clip max-[640px]:overflow-y-visible",
        "grid-rows-[minmax(0,1fr)] max-[640px]:grid-rows-[auto]",
        className,
      )}
    >
      {children}
    </main>
  );
}
