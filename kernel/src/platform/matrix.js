'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 平台矩阵 —— **平台知识的唯一合法位置**（Android-only）
//
// ## 铁律
//
// `process.platform` / `process.arch` **只允许出现在 `src/platform/**`**。
// 业务域（domains/、guard/、api/ 等）必须经本模块或平台层能力取平台事实，
// **不得**自建 os/arch 映射表、不得直接判断 platform。
//
// ## 为什么（本仓付出过的代价）
//
// 同一事实（os/arch → 标签）曾散落 **5 份**（platform/os/*、domains/relay/frpmgr、
// domains/dist、settings-view、plugins），5 份副本必然漂移，且业务域持有的平台知识
// **在非本平台上不会被校验** —— 这正是「内部业务开发悄悄破坏跨平台构建」的机制。
// 现收口为 1 份，并由门禁守住。
//
// ## 安卓事实
//
// 安卓上 Node 的 `process.platform === 'linux'`、`arch === 'arm64'`
// （**与桌面 Linux 无法仅靠 process.platform 区分**，判定真源是 platform/android.js）。
// 故受支持组合只有 **linux/arm64**（osTag='android' 仅作展示用标签）。
//
// 已删除的 PC 遗留（勿回潮）：darwin-x64/arm64、win-x64 发布组合，
// frp 官方产物标签映射（FRP_OS/FRP_ARCH：windows/amd64）——远程控制域（relay/frpc）已整体删除。
// ═══════════════════════════════════════════════════════════════════════════

/** 受支持的平台组合（安卓）：
 * · linux/arm64 —— 真机（绝大多数安卓设备）；
 * · linux/x64 —— x86_64 模拟器与 CI（安卓官方模拟器即此架构）。
 * osTag —— 展示/标签用的 os 段；npmTag —— <osTag>-<arch>。 */
const SUPPORTED = [
  { platform: 'linux', arch: 'arm64', osTag: 'android', npmTag: 'android-arm64' },
  { platform: 'linux', arch: 'x64', osTag: 'android', npmTag: 'android-x64' },
];

/** process.platform → os 段（安卓内核只可能跑在 linux 上，标签为 'android'）。 */
const OS_TAG = { linux: 'android' };

/** process.platform → os 段；不支持返回 null。 @param platform 默认 process.platform */
function osTag(platform) {
  return OS_TAG[platform || process.platform] || null;
}

/** 当前平台/架构事实（业务域取平台事实的**唯一入口**之一）。 */
function current(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  return { platform: p, arch: a, osTag: OS_TAG[p] || null, npmTag: npmTag(p, a) };
}

/** <osTag>-<arch>；不支持**抛错**（与 dist._platformTag 的历史语义一致）。 */
function npmTag(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  const os = OS_TAG[p];
  if (!os || (a !== 'arm64' && a !== 'x64')) {
    throw new Error('不支持的平台组合: ' + p + '/' + a + '（Android 内核仅 linux × arm64/x64）');
  }
  return os + '-' + a;
}

/** 是否为受支持平台组合（安卓：linux × arm64/x64）。 */
function isSupported(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  return SUPPORTED.some((x) => x.platform === p && x.arch === a);
}

/** 是否支持 POSIX 进程组语义（kill(-pid) 整树终止）：安卓（Linux 内核）恒为 true。 */
function supportsProcessGroup(platform) {
  return OS_TAG[platform || process.platform] !== undefined;
}

module.exports = {
  SUPPORTED,
  osTag,
  current,
  npmTag,
  isSupported,
  supportsProcessGroup,
};
