# 术语表

| 术语 | 含义 |
|---|---|
| **OS / Runtime / Program** | Lob OS 的三层实体：原生容器（Kotlin，随 APK 冻结）/ 可插拔运行时（node 现役）/ 载荷（console、dsh、pi…）。见 [ADR-0010](adr/0010-lob-os-container-form.md) |
| **三版本流** | OS、Runtime、Program 各自独立的版本号与交付通道，互不比较（见 [ADR-0004](adr/0004-three-version-streams.md)） |
| **console** | `programs/console`：默认控制面板 Program，可停可换，**不是系统层**（见 [components/console.md](components/console.md)） |
| **单一生命周期** | Android 侧只允许 1 进程 / 1 前台服务 / 1 通知 / 1 控制台承载面 |
| **五层保活** | 锚（无障碍绑定）/ 载体（唯一 FGS + 通知）/ 豁免（电池·Doze 白名单）/ 唤醒（按需短持）/ 可见（QS Tile + 状态同源）；**不设兜底/续跑** |
| **W^X** | 内存页要么可写要么可执行；SELinux 据此禁止 exec 可写目录 |
| **原子切指针** | `CURRENT` 指针指向当前版本目录，切换是 rename（不会半包残留） |
| **自证循环** | 被校验的对象自己提供校验器 → 签名无效的包也能宣布自己有效（本项目刻意切断） |
| **能力令牌** | 桥方法调用前的能力门禁（见 [contracts/bridge-protocol.md](contracts/bridge-protocol.md)） |
| **program_update** | 「能安装已签名 Program 包」——任意设备具备 |
| **build_chain** | 「设备上有编译工具链」——已证伪，**永不置位** |
| **两把信任根** | APK 签名密钥 + Program OTA ed25519 私钥，互相独立（见 [runbook/release.md](runbook/release.md) §3） |
| **Tier A / Tier S** | 普通应用形态 / 系统服务（ROM 集成）形态，见 [components/system.md](components/system.md) |
| **Journal** | 原生侧的落盘事件/中断记录，只做「打断可见」，不做续跑 |
| **SSOT** | Single Source of Truth，单一事实源 |
