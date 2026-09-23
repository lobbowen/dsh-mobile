import type { ReactNode } from "react";
import { cn } from "../utils";
import { Progress } from "../ui/progress";

/**
 * ============================================================================
 * DSH 通用 UI 框架 — Toolbar（响应式页面工具栏）
 * ============================================================================
 * 统一三列 grid：[左槽] [标题区] [右槽]，断点只切换列内容：
 *  - ≥641px：左槽隐藏（menuButton 仅在 ≤640 渲染），标题 = 大标题 + 副标题。
 *  - ≤640px：左槽 = menuButton（汉堡），标题 = 紧凑页名，副标题/进度隐藏。
 * 同一组件按断点自适应 —— 无并列头部行。
 * ============================================================================
 */

export type ToolbarProps = {
  title: string;
  subtitle?: string;
  /** 忙碌进度（0-100），≥641px 显示 */
  progress?: number | null;
  /** 右侧动作区 */
  actions?: ReactNode;
  /** ≤640px 的菜单按钮（汉堡）插槽 */
  menuButton?: ReactNode;
  className?: string;
};

export function Toolbar({
  title,
  subtitle,
  progress,
  actions,
  menuButton,
  className,
}: ToolbarProps) {
  const busy = progress != null;

  return (
    <header
      className={cn(
        "fw-toolbar grid min-h-[76px] min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-b border-border/60 bg-background px-7 max-[980px]:px-6 max-[640px]:gap-2.5 max-[640px]:px-3 max-[640px]:min-h-[52px]",
        className,
      )}
    >
      {/* 左槽：仅 ≤640px 显示菜单按钮 */}
      {menuButton ? (
        <div className="hidden max-[640px]:block">{menuButton}</div>
      ) : null}

      {/* 标题区 */}
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold leading-tight tracking-normal text-foreground max-[640px]:text-base max-[640px]:font-semibold">
          {title}
        </h1>
        {subtitle ? (
          <span className="mt-1.5 block overflow-hidden text-ellipsis whitespace-nowrap text-sm leading-tight text-muted-foreground max-[640px]:hidden">
            {subtitle}
          </span>
        ) : null}
      </div>

      {/* 右槽：动作区（进度并入其前，≥641 显示） */}
      <div className="flex items-center justify-end gap-4 max-[640px]:gap-2 max-[640px]:[&_button]:h-7 max-[640px]:[&_button]:px-2.5 max-[640px]:[&_button]:text-xs">
        {busy ? (
          <div className="hidden w-[190px] max-[640px]:hidden">
            <Progress value={progress} />
          </div>
        ) : null}
        {actions}
      </div>
    </header>
  );
}
