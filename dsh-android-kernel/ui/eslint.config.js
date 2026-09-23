import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import babelParser from "@babel/eslint-parser";

/**
 * ============================================================================
 * dsh-supervisor 控制面板 — ESLint（flat config, ESLint 9）
 * ============================================================================
 * 分工（TS7 + typescript-eslint 不兼容的现实约束，2026-09 定案）：
 *  - 类型正确性   → tsc --noEmit（strict + noUnusedLocals，独立 gate）
 *  - 运行时卫生   → eslint：react-hooks（rules-of-hooks / exhaustive-deps）+ 通用 JS
 *  - TSX 语法解析 → @babel/eslint-parser：.ts 仅 preset-typescript（jsx 关），
 *    .tsx 另加 preset-react（jsx 开）。泛型箭头 <T> 只在非 JSX 模式正确。
 * ============================================================================
 */
function tsBase(jsx) {
  return {
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: jsx
            ? [["@babel/preset-react", { runtime: "automatic" }], "@babel/preset-typescript"]
            : ["@babel/preset-typescript"],
        },
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "no-unused-vars": "off",
      "no-undef": "off",
    },
  };
}

export default [
  { ignores: ["dist/**", "node_modules/**", "ui-react/**"] },
  { files: ["**/*.{ts,tsx}"], ...js.configs.recommended },
  { files: ["**/*.ts"], ...tsBase(false) },
  { files: ["**/*.tsx"], ...tsBase(true) },
];
