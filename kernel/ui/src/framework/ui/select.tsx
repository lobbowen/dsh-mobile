import * as React from "react"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "../utils"

/**
 * ============================================================================
 * DSH 通用 UI 框架 — Select（下拉选择，U1 补齐）
 * ============================================================================
 * 基于 radix-ui Select 的令牌化封装（替代页面裸 <select>），对齐 shadcn 语义：
 *   Select / SelectTrigger / SelectContent / SelectItem / SelectValue / SelectGroup / SelectLabel
 * 样式全部走 CSS 变量令牌；键盘可达 + ARIA 由 Radix 保证。
 * ============================================================================
 */

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Select>) {
  return <SelectPrimitive.Select data-slot="select" {...props} />
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.SelectGroup>) {
  return <SelectPrimitive.SelectGroup data-slot="select-group" {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.SelectValue>) {
  return <SelectPrimitive.SelectValue data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.SelectTrigger>) {
  return (
    <SelectPrimitive.SelectTrigger
      data-slot="select-trigger"
      className={cn(
        "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[placeholder]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.SelectIcon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.SelectIcon>
    </SelectPrimitive.SelectTrigger>
  )
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.SelectContent>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.SelectContent
        data-slot="select-content"
        className={cn(
          "relative z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.SelectViewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
          )}
        >
          {children}
        </SelectPrimitive.SelectViewport>
        <SelectScrollDownButton />
      </SelectPrimitive.SelectContent>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.SelectLabel>) {
  return (
    <SelectPrimitive.SelectLabel
      data-slot="select-label"
      className={cn(
        "px-2 py-1.5 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.SelectItem>) {
  return (
    <SelectPrimitive.SelectItem
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none",
        "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.SelectItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.SelectItemIndicator>
      </span>
      <SelectPrimitive.SelectItemText>{children}</SelectPrimitive.SelectItemText>
    </SelectPrimitive.SelectItem>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.SelectSeparator>) {
  return (
    <SelectPrimitive.SelectSeparator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.SelectScrollUpButton>) {
  return (
    <SelectPrimitive.SelectScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.SelectScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.SelectScrollDownButton>) {
  return (
    <SelectPrimitive.SelectScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.SelectScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
