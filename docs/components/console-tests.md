# programs/console 测试说明（D7）

面板 Program 的测试只覆盖**仍然存在**的代码。旧 console 目录时代面向将删模块的测试
随模块一并移除（D7「逐条：删 / 迁」），删除原因按类归并如下：

| 已移除测试（分类） | 移除原因 |
|---|---|
| `freeze-recovery-test`、`managed-lifecycle-failure-test`、`orphan-lock-reap-test`、`shadow-decision-test`、`daemon-lifecycle-test` | 监督/冻结/孤儿锁/影子决策/daemon 生命周期整体下沉 OS 原生（A11/D9），JS 侧无实现可测 |
| `smoke`、`core-test`、`sigterm-desired-test`、`precheck-test`、`probe-up-httpfallback-test`、`main-port-rederive-test`、`stderr-capture-test` | 针对 `src/console.js`（D9 整体删除）与 guard 监督链 |
| `managed-registry-test`、`ports-claim-test`、`ports-migrate-test`、`ports-verify`、`test-port-discipline-test` | 受管对象目录/端口分配 → OS AppRegistry / PortBroker |
| `native-test`、`native-op-mutex-test`、`native-supply-gate-test`、`upgrade-test`、`npm-contract-chain-test`、`capability-probe-test`、`ripgrep-package-test`、`node-pty-prebuild-test`、`sharp-wasm-test`、`flock-shim-test`、`require-builtin-shim-test`、`uninstall-timeout-behavior-test`、`plugin-change-restart-test` | 运行时装配 / 原生件投放 / 下载安装 / 插件启停 → OS Runtime 供给 + AppManager（A11） |
| `task-registry-test` | 任务注册 → OS Journal（A16：不做 checkpoint/续跑） |
| `runtime-contract-test`、`contract-reload-test`、`node-lts-contract-test`、`agent-descriptor-test` | 运行时契约写侧/载荷描述 → OS 原生 |
| `载荷访问路由测试`、`router-*` | 单载荷专名与网络代理监督 → 泛化为 Program 描述 / PortBroker+NetProxy |
| `loghub-test`、`defects-batch-f-test`、`exec-bounded-gate-test`、`heartbeat-selfheal-test`、`monthly-credits-freeze-test`、`upstream-credits-test`、`commandcode-quota-test`、`router-circuit-breaker-test` | 依赖已下沉模块或载荷专属逻辑 |

保留并新增的门禁：

- `console-not-init-test.js`：「console 不是 init / 可停可换」硬不变量（A10/A11/A12/D9/A16）。
- `api-surface-test.js`：面板 API 契约面双向一致，且系统级端点不得复活。
- `host-bridge-test.js`：Program ↔ OS 能力桥（lobos_hostbridge）传输与降级不变量。
- `market-test.js`：市场索引的泛化配置与 bundle 判定。
- `panel-smoke-test.js`：桥不可用时面板降级且不伪造 OS 状态。

所有测试经 `node --require ./test/_preload.js` 预载；本地执行受
`scripts/require-ci.js` 红线约束（唯一合法验证通道是 CI）。

