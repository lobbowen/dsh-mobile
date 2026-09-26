# dsh-android-kernel 控制面板（React UI）— 架构文档

> 单产品：dsh-android-kernel 控制面板（本目录 `ui/` 即其前端源码；历史名 `skiff-original` / `dsh-supervisor` 已废弃）。
> 技术栈：React 19 + TypeScript + Vite（Rolldown）+ Tailwind 4 + Radix UI + lucide-react + sonner + next-themes。
> 宿主（**单一出口**）：安卓容器（APK）内的 **WebView** / 手机浏览器。面板由内核 HTTP API（同源托管，
> `127.0.0.1:36360` 或容器内环回）直接解析，**零 CORS**——内核不向任何 Origin 发 `Access-Control-Allow-*`。
> ⚠ **已删除的宿主形态（勿回潮）**：① Tauri 桌面完整壳（`window.__TAURI__` / `api_proxy` Rust 转发）；
> ② `ui-react/` 发布镜像（GET / → supervisor.html，浏览器/局域网）；③ 自定义无边框窗口（decorations:false / transparent）。
> 全部 PC 桌面壳概念已随双仓拆分移除，安卓内核只有「容器 WebView / 手机浏览器」一种宿主。
> 内核更新 = **单写入者契约**：面板经 HostBridge 消息桥请安卓容器 OTA 执行（见 `kernel-android-plan.md`）。

---

## 1. 目录结构（全部源文件）

```
src/
  main-supervisor.tsx         入口（唯一）：ReactDOM → AppProviders → SupervisorApp
  app/providers.tsx           ThemeProvider(next-themes) + Toaster（无 i18n、无宿主注入）
  framework/                  业务无关、可复用（无 Tauri/i18n 依赖）
    theme/                    tokens.css（设计令牌 :root/.dark + @theme inline）· shell.css · fonts.css（Inter/Noto SC）· scrollbar.css
    ui/                       Radix+CVA 基件（Button/Checkbox/Dialog/Input/Label/Progress/Select/Spinner/Switch/Sonner Toaster，barrel index.ts）
    layout/                   AppShell/AppLayout/AppSidebar/Toolbar/ContentArea/StatusBar/ScrollArea
    utils.ts                  cn（clsx+tailwind-merge）
    format.ts                 formatSize（文件大小格式化）
  features/supervisor/        业务页面（只依赖 framework + services/supervisor）
    SupervisorApp.tsx         壳：AppSidebar(5 域) + Toolbar + ContentArea + StatusBar
    nav.ts                    导航配置 + 阶段/任务/事件元数据（阶段 tone、友好文案）
    widgets.tsx               标准展示基件（ToneDot/Pill/Card/CardTitle/Metric/QuotaBox/MonoEllipsis）
    OverviewPage.tsx          控制面板（状态/版本/升级/事件日志）
    RouterPage.tsx            智能路由（路由启停/用量/供应商/账号额度/激活）
    TasksPage.tsx             任务中心（统一安装/升级/卸载/更新任务历史）
    PluginsPage.tsx           插件商店（市场浏览/搜索/已装管理/启停/卸载）
    SettingsPage.tsx          设置（访问控制/版本环境/镜像源/关于）
    PortPanel.tsx             运行状态面板（端口实时状态，由 /ports 渲染）
    settings/
      AboutCard.tsx           关于（内核版本 + 检查更新经 HostBridge 请容器 OTA）
      AccessCard.tsx          访问控制（/settings/lan 与 /settings/access-key）
      RegistryCard.tsx        镜像源（registry 配置）
  services/supervisor/        数据层（唯一直接 fetch 的模块）
    types.ts                  全量领域类型（对齐 HTTP API 实契约）
    client.ts                 同源 HTTP 客户端（GET/POST 全端点）
    polling.ts                运行态轮询中心（2s 快照：/status /router/status /router/providers /ports + /events 增量）
    index.ts                  useSupervisorData hook（useSyncExternalStore）
```

> ⚠ **已删除的页面（勿回潮）**：`InstancesPage.tsx`（沙箱实例增删启停）、`LanPage.tsx`（LAN 代理 + FRP 公网穿透）。
> 对应内核域（instance / relay / shell）已随双仓拆分整体移除；插件安装目标只剩 `native`（原生主干），
> 不再有沙箱目标筛选/分组 UI。

## 2. 数据流

- **服务端**：dsh-android-kernel 内核 `src/api/index.js` 同源托管面板产物（HTML 由 `ui/dist` 提供，开发期即此目录）；API 同源，**零 CORS**。
- **单一通路**：面板只走同源 `fetch`（BASE=""），无 Tauri/壳分支、无 `api_proxy` 转发——所有宿主统一为「内核同源 WebView」。
- **前端轮询**：`polling.ts` 每 2s 并行拉运行态（`/status` `/router/status` `/router/providers` `/ports`）+ 增量事件（`/events`，after=seq），写入不可变快照并广播；页面经 `useSupervisorData()` 订阅渲染；写操作经 `supervisorApi.*` → `store.refresh()` 立即同步。
- **UI 文案**：硬编码中文（单一语言产品）。设计令牌定义浅/深主题，暗色经 `next-themes` 跟随系统切换。

## 3. 令牌与规范要点（详见 src/framework/theme/tokens.css）

- 状态语义色：primary / success(+bg) / warning(+bg) / destructive / careful(+bg) / status-ok(-soft/-ring) / status-error(-ring) / status-brand(-ring)。
- 页面禁止硬编码色值/字号；字号只走 text-xs..2xl；状态点 = 呼吸光晕双层；状态徽标 = Pill 语义色。
- 构建：`npm run build` → dist/（supervisor.html + assets/）；多页已移除（单入口）。

---

## 4. 工程治理

### 4.1 代码分包（P1）
- 5 个功能页面（Overview/Router/Tasks/Plugins/Settings）经 React.lazy 按需分包（SupervisorApp.tsx），配 Suspense（PageFallback）+ PageErrorBoundary（chunk 加载失败/页面异常白屏兜底，提供刷新入口）。
- 构建效果：主 vendor+entry 拆双 chunk，各页面独立 chunk，首屏不再含全部页面代码。

### 4.2 UI 基件（U1）
- Select（radix-ui 令牌化，barrel 已导出），PluginsPage / RouterPage 的裸 `<select>` 已迁移；
- 原生 confirm() 保留（同步确认语义在单 WebView 场景可接受）。

### 4.3 质量门禁
- scripts：typecheck（tsc --noEmit）/ lint（eslint src）/ test（vitest run）/ verify（四者串联）。
- 门禁在 CI 强制跑（见 `.github/workflows/ci.yml` 的 `verify` job）：本仓自包含，不依赖壳仓/发布脚本。
- ESLint：flat config + @babel/eslint-parser（preset-typescript + preset-react）。
  **原因**：项目 TypeScript 7.0（preview 标 latest）与 typescript-eslint peer 上限冲突且运行时硬拒 TS7 —— eslint 侧放弃类型规则，纯类型由 tsc strict + noUnusedLocals + noUnusedParameters 承担。
- 单元测试：vitest（node env）+ vi.stubGlobal fetch 注入；覆盖 polling 事件合并去重 / in-flight 守卫、client 错误归一化与超时信号装配。

### 4.4 版本控制
- 前端源码入外层 git 仓；`ui/dist`、`ui/node_modules/` 不入库（gitignore）。
- **产物分发 = 安卓容器 OTA**：`npm run build` 产出的 `ui/dist` 由容器仓经 OTA 打包进 APK，内核不自托管发布/下载逻辑（单写入者契约）。
  ⚠ 已删除的构建/分发形态（勿回潮）：`ui-react/` 镜像、`release/scripts/build-ui.sh`、`release.sh` / `build-sea.sh` / SEA 跨平台打包、Tauri 桌面壳。
- 本仓**不含发布工程**：内核版本/更新状态由容器侧持有，面板只发起「请容器 OTA」请求。
