import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../utils";

/**
 * ============================================================================
 * DSH 通用 UI 框架 — ScrollArea（自动隐藏滚动条）
 * ============================================================================
 * 隐藏原生滚动条，滚动时在右侧显示一条细指示条；
 * 未溢出 / 静止时不显示。macOS / Windows / Linux 视觉统一。
 * ============================================================================
 */

export type ScrollAreaProps = {
  children: ReactNode;
  className?: string;
  /** 指示条宽度（默认 4px） */
  thumbWidth?: number;
  /** 隐藏延迟 ms（默认 800） */
  hideDelay?: number;
};

export function ScrollArea({
  children,
  className,
  thumbWidth = 4,
  hideDelay = 800,
}: ScrollAreaProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const [show, setShow] = useState(false);
  const [thumb, setThumb] = useState({ top: 0, height: 0, visible: false });

  const updateThumb = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const maxScroll = scrollHeight - clientHeight;
    if (maxScroll <= 0) {
      setThumb({ top: 0, height: 0, visible: false });
      return;
    }
    const ratio = clientHeight / scrollHeight;
    const height = Math.max(ratio * clientHeight, 24);
    const top = (scrollTop / maxScroll) * (clientHeight - height);
    setThumb({ top, height, visible: true });
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    setShow(true);
    hideTimer.current = window.setTimeout(() => setShow(false), hideDelay);
  }, [hideDelay]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      updateThumb();
      scheduleHide();
    };
    // 初始检测是否溢出
    const init = () => {
      updateThumb();
      if (el.scrollHeight > el.clientHeight) {
        // 有溢出但未滚动：不显示（保持隐藏）
        setShow(false);
      }
    };
    init();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      updateThumb();
      setShow(false);
    });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [updateThumb, scheduleHide]);

  return (
    <div className={cn("relative min-h-0 min-w-0 overflow-hidden", className)}>
      <div
        className="absolute inset-0 overflow-y-auto overflow-x-hidden scrollbar-none overscroll-contain"
        ref={ref}
      >
        {children}
      </div>
      {/* 滚动指示条 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 right-0 z-10 rounded-full transition-opacity duration-300"
        style={{
          width: thumbWidth,
          margin: 2,
          opacity: show && thumb.visible ? 1 : 0,
        }}
      >
        <div
          className="w-full rounded-full bg-muted-foreground/40"
          style={{ height: thumb.height, transform: `translateY(${thumb.top}px)` }}
        />
      </div>
    </div>
  );
}
