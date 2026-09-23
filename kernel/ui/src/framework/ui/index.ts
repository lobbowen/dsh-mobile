/**
 * ============================================================================
 * DSH 通用 UI 组件库 — 统一出口（Barrel）
 * ============================================================================
 * 用法：
 *   import { Button, Dialog, Input } from "@/framework/ui";
 *
 * 组件命名遵循 shadcn/ui 风格（Radix + CVA + tailwind-merge）。
 * ============================================================================
 */
export { Button, type ButtonProps } from "./button";
export { Checkbox, type CheckboxProps } from "./checkbox";
export { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./collapsible";
export { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
export { Input } from "./input";
export { Label } from "./label";
export { RadioGroup, RadioGroupItem } from "./radio-group";
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
export { Toaster } from "./sonner";
export { Spinner } from "./spinner";
export { Switch } from "./switch";
export { Textarea } from "./textarea";

