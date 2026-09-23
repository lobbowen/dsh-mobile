import type { ComponentType, ReactNode } from "react";
import { cn } from "../utils";

/**
 * ============================================================================
 * DSH 通用 UI 框架 — AppSidebar（应用侧边栏）
 * ============================================================================
 * 通用侧边栏：品牌区（logo + 标题 + 标语）+ 导航项列表 + 底部扩展区。
 * 完全由 props 驱动，业务只需提供导航数据。
 *
 * 用法：
 *   <AppSidebar
 *     brand={{ logo, title, slogan }}
 *     items={[{ key, label, icon, active, badge, onClick }]}
 *     footer={<ModeSwitcher/>}
 *   />
 * ============================================================================
 */

export type SidebarItem = {
  key: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  active?: boolean;
  /** 右侧徽标文字（如体积/数量） */
  badge?: string;
  disabled?: boolean;
  onClick: () => void;
};

export type AppSidebarProps = {
  brand: {
    logo: string;
    title: string;
    slogan?: string;
  };
  items: SidebarItem[];
  /** 底部扩展区（模式切换、用户区等） */
  footer?: ReactNode;
  className?: string;
};

export function AppSidebar({
  brand,
  items,
  footer,
  className,
}: AppSidebarProps) {
  return (
    <aside
      className={cn(
        "fw-sidebar flex min-w-0 flex-col border-r border-black/5 bg-sidebar",
        className,
      )}
    >
      <div className="flex min-h-[78px] items-center gap-3 px-5 max-[640px]:min-h-[64px]">
        <div className="grid size-9 place-items-center rounded-lg border border-black/5 bg-card shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
          <img className="block size-[23px]" src={brand.logo} alt="" aria-hidden="true" />
        </div>
        <div>
          <strong className="block text-[22px] font-bold leading-none tracking-normal text-foreground">
            {brand.title}
          </strong>
          {brand.slogan ? (
            <span className="mt-1 block text-xs leading-tight text-muted-foreground">
              {brand.slogan}
            </span>
          ) : null}
        </div>
      </div>

      <nav className="grid gap-1 px-3 py-2" aria-label={brand.title}>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "flex min-h-[40px] w-full items-center justify-between rounded-lg border border-transparent bg-transparent px-3 text-left text-sidebar-foreground transition-colors hover:bg-card/70 hover:text-foreground",
                item.active &&
                  "border-black/5 bg-card text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.06)]",
                item.disabled && "pointer-events-none opacity-50",
              )}
              disabled={item.disabled}
              key={item.key}
              onClick={item.onClick}
              type="button"
            >
              <span className="inline-flex min-w-0 items-center gap-2.5 text-sm font-medium leading-none">
                <Icon
                  className={item.active ? "text-primary" : undefined}
                  size={17}
                  strokeWidth={1.9}
                />
                {item.label}
              </span>
              {item.badge ? (
                <strong className="max-w-[82px] overflow-hidden text-ellipsis whitespace-nowrap rounded-full bg-card/80 px-2 text-[11px] font-medium leading-5 text-muted-foreground">
                  {item.badge}
                </strong>
              ) : null}
            </button>
          );
        })}
      </nav>

      {footer ? (
        <div className="mt-auto px-3 pb-4 pt-3">
          {footer}
        </div>
      ) : null}
    </aside>
  );
}
