package io.github.lobbowen.dshmobile.kernelota

import android.content.Context
import io.github.lobbowen.dshmobile.RuntimeDiagnostics
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * **设备端自检**：把「整条内核链路绿没绿」直接算出来，交给界面显示。
 *
 * 为什么必须这么做（而不是让用户去 adb 拉文件）：
 *   目标设备的 **adb 是关闭的** —— 任何依赖 adb shell 的验证方式都执行不了，
 *   而 provisioning.json / diagnostics.txt 又都在应用私有目录里。
 *   所以唯一可行的路径是：**设备自己自检、把结论显示在屏幕上**。
 *
 * 三条设计要点：
 *   ① **逐项隔离**：任何一项失败/异常都不影响其他项（自检本身绝不能崩）。
 *   ② **三态**：通过 / 失败 / 未知。没网时"manifest 字段"就是未知，
 *      而**未知不算通过** —— 否则自检就变成了装饰。
 *   ③ **只读**：不安装、不改状态，随时可跑。
 */
object KernelSelfCheck {

    private const val MANIFEST_TIMEOUT_MS = 8_000

    /**
     * 跑一遍自检。**不会抛异常**。
     */
    fun run(ctx: Context): List<SelfCheckReport.Item> {
        val out = mutableListOf<SelfCheckReport.Item>()

        // ① OTA 源配置
        val cfg = try { KernelOtaUpdater.loadConfig(ctx) } catch (_: Throwable) { null }
        out += SelfCheckReport.Item(
            "feed-config",
            cfg != null,
            "OTA 源配置",
            if (cfg == null) "读不到 assets/kernel-feed.json，或 baseUrl 非 https"
            else cfg.baseUrl + "   tag=" + cfg.releaseTag + "   autoCheck=" + cfg.autoCheck,
        )
        if (cfg == null) return out

        // ② manifest 可达性（带 cache-buster，与设备真实读取方式一致）
        val reach = try {
            val t0 = System.currentTimeMillis()
            val conn = (URL(cfg.manifestUrl).openConnection() as HttpURLConnection).apply {
                connectTimeout = MANIFEST_TIMEOUT_MS
                readTimeout = MANIFEST_TIMEOUT_MS
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "dsh-selfcheck")
            }
            val code = conn.responseCode
            val text = if (code in 200..299) conn.inputStream.bufferedReader().use { it.readText() } else ""
            val reqid = conn.getHeaderField("X-Reqid") ?: "(无)"
            conn.disconnect()
            Triple(code, text, (System.currentTimeMillis() - t0) to reqid)
        } catch (e: Throwable) {
            Triple(-1, "", 0L to (e::class.java.simpleName + ": " + (e.message ?: "")))
        }
        out += SelfCheckReport.Item(
            "manifest-reachable",
            reach.first in 200..299,
            "manifest 可取",
            if (reach.first in 200..299) "HTTP " + reach.first + "  " + reach.third.first + "ms  X-Reqid=" + reach.third.second
            else "HTTP " + reach.first + "  " + reach.third.second,
        )
        val m: JSONObject? = try { JSONObject(reach.second) } catch (_: Throwable) { null }

        // ③ manifest 字段完整性 + 有效期（取不到 → 未知）
        if (m == null) {
            out += SelfCheckReport.Item("manifest-fields", null, "manifest 字段齐全", "未取到 manifest，无法判定")
            out += SelfCheckReport.Item("manifest-fresh", null, "manifest 未过期", "未取到 manifest，无法判定")
        } else {
            val need = listOf("version", "sequence", "expiresEpochMs", "rolloutPercent", "sha256", "signature")
            val miss = need.filter { m.optString(it, "").isBlank() }
            out += SelfCheckReport.Item(
                "manifest-fields",
                miss.isEmpty(),
                "manifest 字段齐全",
                if (miss.isEmpty())
                    "version=" + m.optString("version") + "  sequence=" + m.optLong("sequence") +
                        "  rollout=" + m.optInt("rolloutPercent", -1) + "%"
                else "缺字段：" + miss.joinToString(", "),
            )
            val exp = m.optLong("expiresEpochMs", 0L)
            val now = System.currentTimeMillis()
            out += SelfCheckReport.Item(
                "manifest-fresh",
                exp > now,
                "manifest 未过期",
                if (exp <= 0L) "manifest 未声明有效期"
                else "剩余 " + ((exp - now) / 86_400_000L) + " 天",
            )
        }

        // ④ 本地内核状态（CURRENT / FLOOR / PENDING）
        //   目录布局归 KernelManager，这里只经它取（不再自己拼 "kernel" 字面量）。
        val km = KernelManager(ctx)
        val store = KernelStateStore(km.kernelRootDir())
        val cur = store.currentVersion()
        val floor = store.floorVersion()
        val pend = store.pending()
        out += SelfCheckReport.Item(
            "local-state",
            true,
            "本地内核状态",
            "CURRENT=" + (cur ?: "(无)") + "   FLOOR=" + (floor ?: "(无)") + "   PENDING=" + (pend?.version ?: "(无)"),
        )

        // ⑤ OtaPolicy 六规则裁定（纯逻辑）
        if (m != null) {
            val st = try {
                val f = File(ctx.filesDir, "kernel-feed-state.json")
                if (f.isFile) JSONObject(f.readText()) else JSONObject()
            } catch (_: Throwable) { JSONObject() }
            val v = OtaPolicy.evaluate(
                OtaPolicy.Input(
                    remoteVersion = m.optString("version", ""),
                    currentVersion = cur,
                    floorVersion = floor,
                    expiresEpochMs = m.optLong("expiresEpochMs", 0L),
                    sequence = m.optLong("sequence", 0L),
                    lastSequence = st.optLong("lastSequence", 0L),
                    rolloutPercent = m.optInt("rolloutPercent", 100),
                    installId = st.optString("installId", "selfcheck"),
                    nowMs = System.currentTimeMillis(),
                ),
            )
            val desc = when (v) {
                is OtaPolicy.Verdict.Reject -> "拒绝（" + v.code + "）：" + v.message
                is OtaPolicy.Verdict.UpToDate -> "已是最新：" + v.message
                is OtaPolicy.Verdict.Available -> "有更新：" + v.message
                is OtaPolicy.Verdict.Holdback -> "灰度未命中（正常）：" + v.message
                OtaPolicy.Verdict.Install -> "可安装"
            }
            // 被拒 = 安全约束生效，属预期；这里 ok=true 表示"规则判定本身正常"。
            out += SelfCheckReport.Item("policy", true, "OTA 裁定", desc)
        }

        // ⑥ 下载半包 / 安装暂存（判据是纯逻辑，见 SelfCheckReport.partialItem）
        //   这里只负责**采事实**：谁是半包由 ResumableDownloader.isPartialFile 说一次，
        //   谁算暂存由 KernelManager.isStagingDir 说一次 —— 自检不自己拼字符串。
        val parts = try {
            (ctx.cacheDir.listFiles() ?: emptyArray()).filter { ResumableDownloader.isPartialFile(it.name) }
                .map { it.name to it.length() }
        } catch (_: Throwable) { emptyList() }
        val staging = try {
            (km.kernelRootDir().listFiles() ?: emptyArray()).filter { KernelManager.isStagingDir(it.name) }.map { it.name }
        } catch (_: Throwable) { emptyList() }
        out += SelfCheckReport.partialItem(parts, staging)

        // 原先这里还有第 ⑦ 项「ADB 通道」（手抄一份 state.json 存在性判断）。自检的职责是
        // **内核包本身**是否健康，通道属设备能力事实 —— 两处各判一次正是「自检说绿、首页说红」
        // 的错位来源，故整项删除，能力事实只在 CapabilityCatalog 里有一份。
        return out
    }

    /** 自检并渲染；同时把结果写进诊断日志（便于事后追溯）。 */
    fun runAndFormat(ctx: Context): String {
        val items = run(ctx)
        val text = SelfCheckReport.format(items)
        try {
            RuntimeDiagnostics.append(ctx, "selfcheck", SelfCheckReport.overallOk(items), "设备端自检", text)
        } catch (_: Throwable) { }
        return text
    }
}
