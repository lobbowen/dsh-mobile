/**
 * supervisor 业务共享格式化 —— 页面一律走这里，禁止页面级重定义 fmt 函数。
 * 覆盖后端常见时间形态：ISO 字符串 / 毫秒时间戳 / Date。
 */
const pad = (n: number) => String(n).padStart(2, "0");

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO/时间戳 → "HH:MM"（事件时间、检查时间等） */
export function formatClockTime(v?: string | number | Date | null, empty = "—"): string {
  const d = toDate(v);
  if (!d) return empty;
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/** ISO/时间戳 → "MM-DD HH:MM[:SS]"（任务历史等，秒可省） */
export function formatDateTime(v?: string | number | Date | null, withSeconds = false, empty = "—"): string {
  const d = toDate(v);
  if (!d) return empty;
  const base = pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  return withSeconds ? base + ":" + pad(d.getSeconds()) : base;
}

/** 千分位数字（英文 locale，与老 UI 一致） */
export function formatCount(n?: number | null): string {
  return Number(n ?? 0).toLocaleString("en-US");
}
