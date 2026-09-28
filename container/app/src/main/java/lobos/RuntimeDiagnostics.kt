package lobos

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import lobos.os.Journal
import org.json.JSONObject

/**
 * 跨进程诊断日志（文件型）+ **结构化事件**（债 E7）。
 *
 * 过去是自由文本：能看不能算。现在每条诊断都同时落两份：
 *  · files/diagnostics.txt —— 人读（保持既有渲染/轮询不变）；
 *  · files/os/diag.jsonl   —— 机读（stage / level / message / detail 字段化，
 *    [DiagEvent.data] 承载探针的原始结构化结论），
 *    并镜像进 [Journal]，与 os/state.json 一道构成"对外唯一状态"的单一来源（C1）。
 *
 * [DiagEvent.data] 是这一轮才补上的：**没有它，机读面只剩人读文案的副本** ——
 * 探针把逐格结论算好就丢了，下游要想用只能把 detail 再 parse 回结构（那就是第二把尺子），
 * 或者现场重跑一次探针（那就是把「按需」当成「已核验」）。债表 D12。
 *
 * 纪律：诊断是**观测面**，不是恢复机制 —— 这里不提供 checkpoint / replay。
 */
object RuntimeDiagnostics {

    enum class Level { INFO, OK, FAIL }

    data class DiagEvent(
        val atMs: Long,
        val stage: String,
        val level: Level,
        val message: String,
        val detail: String,
        /** 探针的原始结构化结论（可空）：机读消费者取这里，不解析 [detail]。 */
        val data: JSONObject? = null,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("at", atMs)
            put("stage", stage)
            put("level", level.name)
            put("message", message)
            put("detail", detail)
            data?.let { put("data", it) }
        }
    }

    private const val FILE = "diagnostics.txt"
    private const val NODE_ERR = "node-stderr.log"
    private const val STRUCT_DIR = "os"
    private const val STRUCT_FILE = "diag.jsonl"

    private val tsFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun file(ctx: Context): File = File(ctx.filesDir, FILE)
    fun nodeErrFile(ctx: Context): File = File(ctx.filesDir, NODE_ERR)
    private fun structFile(ctx: Context): File {
        val d = File(ctx.filesDir, STRUCT_DIR)
        d.mkdirs()
        return File(d, STRUCT_FILE)
    }

    @Synchronized
    fun clear(ctx: Context) {
        // 仅清空诊断主文件；node-stderr.log 保留，便于失败时回看 node 自身报错
        file(ctx).writeText("")
        runCatching { structFile(ctx).writeText("") }
    }

    /**
     * 追加一条诊断（兼容既有调用点）。
     * @param ok null=进行中/信息, true=成功, false=失败
     * @param data 探针的结构化结论；只在「这一条诊断本身就算结构化结果」时传（见 [DiagEvent.data]）
     */
    @Synchronized
    fun append(
        ctx: Context,
        stage: String,
        ok: Boolean?,
        message: String,
        detail: String = "",
        data: JSONObject? = null,
    ) {
        val level = when (ok) {
            true -> Level.OK
            false -> Level.FAIL
            null -> Level.INFO
        }
        appendEvent(ctx, DiagEvent(System.currentTimeMillis(), stage, level, message, detail, data))
    }

    /** 结构化入口：文本 + JSONL + Journal 三处同步写（同一次调用）。 */
    @Synchronized
    fun appendEvent(ctx: Context, ev: DiagEvent) {
        val ts = tsFmt.format(Date(ev.atMs))
        val mark = when (ev.level) {
            Level.OK -> "[OK]"
            Level.FAIL -> "[FAIL]"
            Level.INFO -> "[..]"
        }
        val line = buildString {
            append(ts + " " + mark + " " + ev.stage + ": " + ev.message)
            if (ev.detail.isNotBlank()) {
                append("\n      " + ev.detail.replace("\n", "\n      "))
            }
        }
        runCatching { file(ctx).appendText(line + "\n") }
        runCatching { structFile(ctx).appendText(ev.toJson().toString() + "\n") }
        runCatching {
            Journal.append(
                ctx, "diag:" + ev.stage,
                null,
                ev.level.name + " " + ev.message + (if (ev.detail.isBlank()) "" else " | " + ev.detail.take(300)),
            )
        }
    }

    /** 结构化读取（最新在最后）；坏行跳过。 */
    @Synchronized
    fun events(ctx: Context, limit: Int = 100): List<DiagEvent> {
        val out = mutableListOf<DiagEvent>()
        runCatching {
            val f = structFile(ctx)
            if (!f.exists()) return emptyList()
            f.readLines().forEach { raw ->
                if (raw.isBlank()) return@forEach
                val o = runCatching { JSONObject(raw) }.getOrNull() ?: return@forEach
                out.add(
                    DiagEvent(
                        atMs = o.optLong("at"),
                        stage = o.optString("stage"),
                        level = runCatching { Level.valueOf(o.optString("level", "INFO")) }
                            .getOrDefault(Level.INFO),
                        message = o.optString("message"),
                        detail = o.optString("detail"),
                        data = o.optJSONObject("data"),
                    )
                )
            }
        }
        return out.takeLast(limit)
    }

    /**
     * 每个 stage **最新一条**落盘诊断（机读消费者用）。
     *
     * 取的是已经落盘的结论，绝不现场重跑探针 —— 「按需再验一次」和「上一轮验过什么」
     * 是两个事实，混在一个读法里就等于把没验过说成验过（债 D12）。
     * 某档没有记录就**不出现在返回里**：缺失要能被下游看出来，不给初值充当结论。
     */
    @Synchronized
    fun latestByStage(ctx: Context, vararg stages: String, limit: Int = 400): Map<String, DiagEvent> {
        val wanted = stages.toSet()
        val out = LinkedHashMap<String, DiagEvent>()
        // events() 按写入序返回（最新在最后），逐档覆盖即为该档最新一条。
        events(ctx, limit).forEach { ev -> if (wanted.contains(ev.stage)) out[ev.stage] = ev }
        return out
    }

    @Synchronized
    fun read(ctx: Context): String =
        if (file(ctx).exists()) file(ctx).readText() else ""

    @Synchronized
    fun recordNodeStderr(ctx: Context, text: String) {
        if (text.isNotBlank()) nodeErrFile(ctx).appendText(text)
    }

    /** 每次 spawn 前清空：stderr 是跨轮累积追加的，不清空会把上一轮进程的死因顶给本轮。 */
    @Synchronized
    fun clearNodeStderr(ctx: Context) {
        if (nodeErrFile(ctx).exists()) nodeErrFile(ctx).delete()
    }

    fun readNodeStderr(ctx: Context): String =
        if (nodeErrFile(ctx).exists()) nodeErrFile(ctx).readText() else ""
}
