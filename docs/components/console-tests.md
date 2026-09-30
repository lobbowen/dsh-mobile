# programs/console 测试说明

## 现在这一份是哪一代

2026-10-01 面板整体回到 **.47 世代**（tag `kernel-0.1.0-android.47` → commit `f6b5cbc768ae5c115d105d59d94bd8bab261f4d1`，
源目录 `kernel/` 的 236 个文件平移进 `programs/console/`）。理由在册：.47 之后那批「把面板职责逐条下沉给
JS 侧替身」的改动被判定为错，控制面板先回到能跑的那一代。

因此本文此前那份「D7 已移除测试清单」**作废**：清单点名的 43 条测试与 `router-*` 那五条，连同各自的被测模块
一起回来了（2026-10-01 逐条核过 `programs/console/test/`，48/48 在）。

## 随 .48 世代代码一起消失的三条

| 文件 | 去向 |
|---|---|
| `test/market-test.js` | 被测的市场泛化模块属 .48 世代；市场侧现存判据是 `test/market-budget-test.js` |
| `test/panel-smoke-test.js` | 「桥不可用时不伪造 OS 状态」这一格由 `test/host-bridge-test.js` 的 H-3 判（`call()` 返 null 且不抛、`handshake()` 返 null） |
| `test/console-not-init-test.js` | 「console 不是 init」整条判据在仓内**不再有宿主**——这是欠账，不是完成，见下 |

## 明写的缺口

原 `console-not-init-test.js` 钉的「面板不常驻、可停可换」（A10/A11/A12/D9/A16）里，
「零自更新面」有 `test/program-update-single-writer-test.js`、「守卫退出不动期望状态」有
`test/sigterm-desired-test.js`、端口权威有 `test/test-port-discipline-test.js` 各自判着；
但它那条**「全 src 禁 `child_process`」**没有回来，而它的替换判据（判据对象从「不许出现某个词」换成
「不得自持常驻权威」，配能红的双向夹具：`setInterval`＋自拉起 ⇒ 红、`spawn("git")` ⇒ 绿）**尚未落地**。
这条欠账在册债表 **ENV-21**，不许因为它对应的文件没了就当已解决。

## 链怎么跑

- `package.json` 的 `test` 是 61 段串行链，另有 `test:native-uninstall`、`test:plugin-change-restart` 两段独立入口；
- 每段都经 `node --require ./test/_preload.js` 预载（夹具与安卓路径开关）；
- 安卓行为面由 CI 的 console job 以 `LOBOS_ANDROID=1` 跑；
- 本地执行受 `scripts/require-ci.js` 红线约束：唯一合法验证通道是 CI。
