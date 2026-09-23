import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * vitest 配置：复用 vite 基础（插件/esm），测试环境 node + jsdom 覆盖
 * 单元测试聚焦纯逻辑（polling 合并去重、client 错误归一化/超时、格式化）。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    globals: true,
    // polling.ts / client.ts 依赖 fetch（同源）—— 用 vi.stubGlobal 注入
  },
});
