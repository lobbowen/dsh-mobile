package io.github.lobbowen.dshmobile.capability

/**
 * 桥能力令牌（L0↔L1 契约面，docs/contracts/bridge-protocol.md）的**唯一派生处**。
 *
 * 为什么住在能力层而不是 [io.github.lobbowen.dshmobile.bridge.HostBridgeService]：
 * 令牌名是对内核的契约，但「令牌该不该置位」问的是设备事实 —— 而设备事实只有
 * [CapabilityCatalog] 有权判定。v1 在桥里手写凭据文件存在性与 `isDeviceOwnerApp`，
 * 首页与桥各写一份判据，真机 2026-09-25 的「首页说绿、桥说没能力」就是这么来的。
 *
 * 派生走 [CapabilityCatalog.rawJudge]（未经 DAG 门控的原始事实）而不是
 * [CapabilityCatalog.evaluate]：令牌回答「这台机器此刻具备不具备这个事实」，不回答
 * 「它排在第几步」。若吃门控后的结论，无线调试开关在部分 ROM 上读不到时就会把
 * **已经可用**的 shell 通道砍掉 —— 那是砍能力迁就缺陷，禁止。
 */
object BridgeTokens {

    /** 与设备事实无关的静态令牌：任何装机都具备，因此不经判据。 */
    const val BASE = "base"

    /**
     * 内核自举安装只做「从本地文件安装已签名内核」：读 /sdcard 靠 fs.* 已有的
     * MANAGE_EXTERNAL_STORAGE（未授权时回落应用专属目录），写 filesDir 是应用自身权限，
     * 校验走 Node 自带 OpenSSL —— 任意设备都具备。
     *
     * 刻意与 `build_chain` 区分：后者表示「设备上有编译工具链」，那个方案已证伪
     * （无 aarch64 aapt2），所以它**不**在这里置位，依赖它的调用方继续拿 -32001。
     */
    const val KERNEL_UPDATE = "kernel_update"

    fun from(e: Evidence): Set<String> {
        val caps = mutableSetOf(BASE, KERNEL_UPDATE)
        CapabilityCatalog.ALL.forEach { c ->
            val token = c.bridgeToken ?: return@forEach
            if (CapabilityCatalog.rawJudge(c.id, e)?.status == CapStatus.GRANTED) caps += token
        }
        return caps
    }
}
