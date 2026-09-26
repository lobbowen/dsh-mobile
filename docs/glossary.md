# 术语表

| 术语 | 含义 |
|---|---|
| **L0 / L1 / L2 / L3** | 容器（APK）/ 内核（Node）/ Agent 产品 / HostBridge 能力桥 |
| **壳** | L0，Android APK 容器层 |
| **内核** | L1，可经 OTA 热更新的 Node 运行时 |
| **W^X** | 内存页要么可写要么可执行；SELinux 据此禁止 exec 可写目录 |
| **原子切指针** | `CURRENT` 指针指向当前版本目录，切换是 rename（不会半包残留） |
| **自证循环** | 被校验的对象自己提供校验器 → 签名无效的内核也能宣布自己有效（本项目刻意切断） |
| **能力令牌** | 桥方法调用前的能力门禁（见 [contracts/bridge-protocol.md](contracts/bridge-protocol.md)） |
| **kernel_update** | 「能安装已签名内核」——任意设备具备 |
| **build_chain** | 「设备上有编译工具链」——已证伪，**永不置位** |
| **两把信任根** | APK 签名密钥 + 内核 OTA ed25519 私钥，互相独立（见 [runbook/release.md](runbook/release.md) §3） |
| **Tier A / Tier S** | 普通应用形态 / 系统服务（ROM 集成）形态，见 [components/system.md](components/system.md) |
| **SSOT** | Single Source of Truth，单一事实源 |
