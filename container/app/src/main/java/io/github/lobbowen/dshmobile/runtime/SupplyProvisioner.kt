package io.github.lobbowen.dshmobile.runtime

import android.content.Context
import java.io.File

/**
 * C 层共享供给的**容器侧执行者**（APK 是 C 的共享层：它服务所有产品，与产品无关）。
 *
 * 为什么住这里（用户 2026-09-29 复核）：「如果加到内核里，那只有内核才能适配；我再装一个 DSH/Codex，
 *   这些东西还要再加一遍 —— 它们是共用的。」所以机制随 APK 走，内核只检测 + 触发。
 *
 * 做法：把 assets/supply/** 刷到 $PREFIX/lib/supply/**（幂等，按大小比对），再用容器自己的 node
 *   跑 index.js；prefix / npm 入口 / node 路径经环境变量交给它（容器本来就是这些事实的写者）。
 */
object SupplyProvisioner {

    private const val ASSET_DIR = "supply"

    fun dir(ctx: Context): File = File(PrefixProvisioner.root(ctx), "lib/supply")

    /** 刷出供给机制本体，返回入口脚本（assets 里没有就返回 null —— 如实降级，不伪造）。 */
    fun stage(ctx: Context): File? {
        val dst = dir(ctx)
        dst.mkdirs()
        val names = try { ctx.assets.list(ASSET_DIR) ?: emptyArray() } catch (_: Throwable) { emptyArray() }
        if (names.isEmpty()) return null
        for (n in names) {
            val out = File(dst, n)
            try {
                ctx.assets.open("$ASSET_DIR/$n").use { input ->
                    val bytes = input.readBytes()
                    if (!out.isFile || out.length() != bytes.size.toLong()) out.writeBytes(bytes)
                }
            } catch (_: Throwable) { /* 单文件失败不致命：入口在不在由返回值如实回答 */ }
        }
        return File(dst, "index.js").takeIf { it.isFile }
    }
}
