import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "../framework/ui/sonner";

/**
 * ============================================================================
 * dsh-supervisor 控制面板 — Providers
 * ============================================================================
 * 只保留框架级 Provider：
 *  - ThemeProvider（暗色主题，attribute="class"，跟随系统）
 *  - Toaster（全局通知）
 * 数据通道：supervisorStore（services/supervisor）内部轮询，无需全局注入。
 * 文案：面板使用硬编码中文（单一语言产品），无 i18n 依赖。
 * ============================================================================
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
      <Toaster />
    </ThemeProvider>
  );
}
