import { cn } from "../utils";

type ProgressProps = {
  value: number;
  className?: string;
  /** 无障碍标签（默认中文 "加载进度"） */
  ariaLabel?: string;
};

export function Progress({ value, className, ariaLabel = "加载进度" }: ProgressProps) {
  const safeValue = Math.max(0, Math.min(100, value));

  return (
    <div
      aria-label={ariaLabel}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={safeValue}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-300"
        style={{ width: `${safeValue}%` }}
      />
    </div>
  );
}
