package io.github.lobbowen.dshmobile.kernelota

/**
 * 启动链的**内核解析**：CURRENT + 入口是否就位 → 该起内核还是回落探针。
 *
 * 为什么单独抽出来：这是「内核装不上 / 起不来」这类问题的**归因入口**，
 * 而它此前只有**两态**（有内核 / 没内核），于是把一种很具体的故障混进了笼统描述：
 *
 *   · 从未安装成功           → CURRENT 缺失
 *   · **上次 OTA 只落地一半** → CURRENT 已指向某版本，但该版本的入口不存在
 *
 * 两者在旧实现里都报「尚无内核包（OTA 尚未安装成功）」。第二种其实说明
 * **安装确实发生过**，排查方向完全不同（去看那一次的 install/verify 日志，
 * 而不是去查网络与 feed）。抽成纯逻辑后，这两种状态可以被钉住。
 */
object KernelResolution {

    enum class State {
        /** 从未安装（CURRENT 缺失）——**合法状态**，首装尚未成功。 */
        ABSENT,
        /** CURRENT 指向某版本，但该版本的入口不存在 —— 安装只落地了一半。 */
        INCOMPLETE,
        /** 内核就位，按脚本交给 node 解释执行。 */
        READY,
    }

    data class Resolved(
        val state: State,
        val version: String?,
        val ok: Boolean,
        val title: String,
        val detail: String,
    )

    /**
     * @param currentVersion files/kernel/CURRENT 的内容（null/空白 = 缺失）
     * @param entryPath      入口的**绝对路径**（仅用于拼诊断文本；ACTION 依赖它）
     * @param entryExists    入口文件是否真的存在
     */
    fun resolve(currentVersion: String?, entryPath: String?, entryExists: Boolean): Resolved {
        val v = currentVersion?.trim()?.ifBlank { null }
        if (v == null) {
            return Resolved(
                state = State.ABSENT,
                version = null,
                ok = false,
                title = "尚无内核包（OTA 尚未安装成功）",
                detail = "files/kernel/CURRENT 缺失；本次回落到 assets/node/server.js 探针模式（内核需经 OTA 安装）",
            )
        }
        if (!entryExists) {
            return Resolved(
                state = State.INCOMPLETE,
                version = v,
                ok = false,
                title = "内核不完整（CURRENT=" + v + "，但入口缺失）",
                detail = "CURRENT 已指向 " + v + "，却找不到入口" +
                    (entryPath?.let { "（" + it + "）" } ?: "") +
                    "；本次回落探针模式。**归因提示**：说明安装确实发生过，" +
                    "应查那一次的 install/verify 日志（可能只落地了一半），而不是查网络与 feed。",
            )
        }
        return Resolved(
            state = State.READY,
            version = v,
            ok = true,
            title = "内核版本=" + v,
            detail = "入口=" + (entryPath ?: "(未知)"),
        )
    }
}
