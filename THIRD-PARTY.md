# 第三方组件与出处（attribution 集中登记）

> 规则见 `docs/standards/branding.md`：第三方品牌**只允许**出现在本文件与 `docs/**` 的事实描述中，
> 不得进入代码标识符、界面文案、包名、环境变量与原生件名。

| 组件 | 版本/来源 | 用途 | 许可证 |
|---|---|---|---|
| Node.js | 24.x（native 资产） | 运行时 | MIT |
| c++ shared runtime | NDK | 原生依赖 | Apache-2.0/BSD |
| ripgrep | 14.x | grep/glob 能力件 | MIT/Unlicense |
| sqlite3 / curl / git / jq | 见 scripts/build-userland-*.sh | 用户态工具（$PREFIX 自装） | 各自许可证 |
| @deepseek-ai/node-addon-system | npm（**载荷侧依赖**，见下） | dsh 载荷的 flock 入口 | 见包内 LICENSE |

## 载荷侧依赖（不属于 OS）
- `dsh` 载荷自带的 npm 依赖（含 `@deepseek-ai/*`）属于**载荷**，由 `programs/dsh/` 与其适配器负责；
  OS 不引用、不命名、不保证。OS 仅提供 `LOBOS_*` 命名空间与原生原语。
