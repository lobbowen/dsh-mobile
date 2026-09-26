# system/ —— 容器作为系统服务（Tier S）的集成契约

本目录是把容器以「系统服务」形态落到 ROM 的集成面，与 `app/`（Tier A，普通应用）并存。
Tier A 是兼容层：目标设备我们碰不到时只能用它，代价是一整套垫片；
Tier S 是底座正解：容器成为特权系统服务，垫片全部消失。

## 为什么必须是系统服务

`untrusted_app` 域在四个方向上封死了容器：自家目录禁 `execve`、`link(2)` 被 neverallow、
祖先目录不可读（durable fsync 必挂）、`unshare(CLONE_NEWUSER)` 被应用 seccomp 挡成 EINVAL。
这四条都不是缺 API，而是「普通应用」这个身份本身带来的。见 ../adr/0001-android-execution-domain.md。

## 落地通道（按可获得性排序）

1. 厂商预装：由 OEM 用平台密钥把本容器签为 priv-app 随系统出厂（产线机唯一可行路径）。
2. 工程机/userdebug ROM：`ro.debuggable=1` + `adb root && adb remount` 即可自行投放。
3. 自有可控设备：可解锁 bootloader 的机型/开发板，直接刷入本目录产出的系统集成。

产线锁定的用户机（如 OPPO PLP120：`flash.locked=1`、`oem_unlock_supported` 空、user 版）
不存在软件路径，只能走通道 1。

## 目录内容

- `Android.bp`：以 priv-app 形式把 APK 打进系统镜像。
- `privapp-permissions-io.github.lobbowen.dshmobile.xml`：特权权限白名单（priv-app 必需）。
- `sepolicy/`：容器自有域 `dsh_container` 的最小权限策略与文件标签。
- `init/init.dsh.rc`：开机即起、崩溃重启的容器服务定义。
- `kernel/dsh_container.configfrag`：自有内核需打开的内核配置（命名空间等）。

## 集成步骤（AOSP/ROM 树）

1. `Android.bp` 与 `privapp-permissions-*.xml` 放入 `vendor/dsh/container/`。
2. `sepolicy/` 文件落到 `device/<vendor>/<device>/sepolicy/`（`file_contexts` 需与现有文件合并）。
3. `init/init.dsh.rc` 落到 `device/<vendor>/<device>/init/`，并把 sepolicy 目录加进 `BOARD_VENDOR_SEPOLICY_DIRS`。
4. 用 `sepolicy-analyze` 与整编校验 neverallow；本目录策略是按最小权限写的模板，必须过整编。
5. 内核若自编，追加 `kernel/dsh_container.configfrag`，使真命名空间容器（路线 A）可用。

## Tier S 到位后可删除的垫片

- `container/app/build.gradle.kts` 的 `targetSdk = 28`（exec 限制不再适用）
- `container/native/posix/*`（`link(2)` 替代与 open 回退）
- `PrefixProvisioner` 的 lib→真名复制（可直接以镜像内可执行文件分发）
