import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  // 单一产品入口：console.html（lobos-panel 控制面板，同源托管于 :3100）
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: { console: "console.html" },
    },
    chunkSizeWarningLimit: 1100,
  },
}));
