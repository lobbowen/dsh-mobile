import * as React from "react";
import { cn } from "../utils";

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {}

/** 令牌化勾选框：勾号用内联 SVG background 绘制（受控组件按 checked 直接切态），
 *  勾号始终居中于框内（不依赖浏览器原生 appearance 渲染）。
 *  注意：SVG 属性一律用双引号 —— encodeURIComponent 不编码单引号，会提前闭合 CSS url('…')。 */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ className, checked, ...props }, ref) {
    const checkSvg =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3.8 8.4l2.8 2.8 5.6-6"/></svg>',
      );
    return (
      <input
        className={cn(
          "h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-[4px] transition-colors",
          "border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-45",
          checked
            ? "border-transparent bg-primary bg-[length:100%_100%] bg-center bg-no-repeat"
            : "border-input bg-card",
          className,
        )}
        style={checked ? { backgroundImage: "url(" + JSON.stringify(checkSvg) + ")" } : undefined}
        checked={checked}
        ref={ref}
        type="checkbox"
        {...props}
      />
    );
  },
);
