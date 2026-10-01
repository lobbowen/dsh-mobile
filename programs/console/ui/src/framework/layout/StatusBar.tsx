import type { ReactNode } from "react";
import { cn } from "../utils";

/**
 * ============================================================================
 * DSH 通用 UI 框架 — StatusBar（底部状态栏）
 * ============================================================================
 * 页面底部：左侧（版本/状态）+ 右侧（说明文字）。
 * ============================================================================
 */

export type StatusBarProps = {
  /** 左侧内容（如版本号） */
  left?: ReactNode;
  /** 右侧内容（如最近操作说明） */
  right?: ReactNode;
  className?: string;
};

export function StatusBar({ left, right, className }: StatusBarProps) {
  return (
    <footer
      className={cn(
        "flex min-h-10 min-w-0 items-center justify-between gap-2 border-t border-black/5 bg-background px-7 text-muted-foreground max-[980px]:px-6 max-[640px]:h-auto max-[640px]:flex-col max-[640px]:items-stretch",
        className,
      )}
    >
      {left ? (
        <div className="flex min-w-0 items-center gap-[7px]">{left}</div>
      ) : null}
      {right ? (
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-tight">
          {right}
        </span>
      ) : null}
    </footer>
  );
}
