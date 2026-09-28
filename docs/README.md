# Lob OS 文档索引

本目录是**全部文档的唯一归宿**。源码目录（`container/`、`programs/`、`scripts/`）内不再存放文档。

## 目录结构

| 路径 | 内容 | 变更政策 |
|---|---|---|
| `architecture.md` | 架构与硬约束（**改代码前必读**） | 随源码演进 |
| `adr/` | 架构决策记录（含"已否决"） | **只增不改**（历史不可改写） |
| `contracts/` | 机器可读 + 人读契约（**被代码消费，路径不可移动**） | 随源码演进 |
| `standards/` | 仓库级规范（品牌 / 存储 / 测试） | 随流程演进 |
| `runbook/` | 操作手册（开发 / 发布 / 运维） | 随流程演进 |
| `components/` | 各组件说明（容器 / console / console UI / 原生件 / Tier S） | 随源码演进 |
| `plans/` | 在途方案：**主方案只许一份**（`os-v4-execution-plan.md`），其余为它的支撑文档（架构 / 常驻调查 / 验证方案 / 品牌总账）与 `archive/` 历史 |

## 快速导航

- 想懂**为什么这么设计** → [architecture.md](architecture.md) + [ADR-0010](adr/0010-lob-os-container-form.md)
- 想**改代码** → [runbook/contributing.md](runbook/contributing.md)
- 想**跑/写测试** → [standards/testing.md](standards/testing.md)
- 想**发布** → [runbook/release.md](runbook/release.md)
- 想**改 console Program / Program OTA** → [components/console.md](components/console.md) + [runbook/program-ota.md](runbook/program-ota.md)
- 想**看接口契约** → [contracts/bridge-protocol.md](contracts/bridge-protocol.md) + [contracts/base-spec.md](contracts/base-spec.md)
- 名词不懂 → [glossary.md](glossary.md)

## 文档纪律

1. **一事实一处**：同一事实不在两份文档里各写一份；需要引用就用相对链接。
2. **以源码为准**：文档与源码冲突时**改文档**（或同时改两者并说明），不允许矛盾留存。
3. **不写历史叙事**：事故的完整排查过程归 git 历史；文档只保留「现在必须知道什么」。
4. **不留旧路径**：目录迁移后文档里的旧路径必须同步，不允许出现指向不存在文件的链接。
5. **被取代的方案归档而非标注**：作废方案移入 `plans/archive/` 并在抬头写明被谁取代。
