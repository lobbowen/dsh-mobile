import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      size: {
        // 默认：页面主操作 / Toolbar 动作
        default: "h-9 px-3 text-sm",
        // 紧凑：卡片行内操作
        sm: "h-8 px-3 text-sm",
        // 胶囊/圆角小操作（检测更新等 chip 形态）
        chip: "h-7 rounded-full px-2.5 text-xs",
      },
      variant: {
        default:
          "border-transparent bg-[image:var(--primary-btn-grad)] text-primary-foreground shadow-[var(--primary-btn-shadow)] hover:bg-[image:var(--primary-btn-grad-hover)]",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline:
          "border-border bg-card text-card-foreground hover:bg-accent hover:text-accent-foreground",
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      type={type}
      {...props}
    />
  );
}

/** 变体工厂导出（U1：AlertDialog 等组合组件复用同一套按钮令牌） */
export { buttonVariants };
