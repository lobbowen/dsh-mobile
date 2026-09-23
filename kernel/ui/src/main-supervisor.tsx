/**
 * dsh-supervisor 控制面板入口（唯一产品入口）
 * 使用场景：同源托管于 dsh-supervisor :3100（GET / → supervisor.html → 此入口）。
 *
 * 资源一致性由架构保证（无自愈/强制刷新脚本）：
 *  - 后端 HTML no-store：每次请求拿到最新 index
 *  - 资源内容哈希：HTML 引用的 JS/CSS 永远自洽
 *  - 宿主（dsh-supervisor-gui）每次显示窗口重新导航到 / ：旧 WebView 不留存
 * React 挂载时 createRoot 自动替换 #root 内的品牌启动壳。
 */
import React from "react";
import ReactDOM from "react-dom/client";
// 设计令牌 + Tailwind（UI 全部样式来源，唯一入口在此）
import "./framework/theme";
import { AppProviders } from "./app/providers";
import { SupervisorApp } from "./features/supervisor/SupervisorApp";

// 桌面程序禁用鼠标右键（2026-09 用户定稿）：右键在壳窗口会触发 WebKit 上下文菜单 /
// 误触进入错误状态——全局拦截 contextmenu，浏览器内置右键菜单不出现。
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppProviders>
      <SupervisorApp />
    </AppProviders>
  </React.StrictMode>,
);
