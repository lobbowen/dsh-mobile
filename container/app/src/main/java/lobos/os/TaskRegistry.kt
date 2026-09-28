package lobos.os

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * 安装/升级/卸载任务的**唯一账本**（`files/os/tasks.json`）。
 *
 * 契约 §2.1 的 `os.journal.tasks` / `os.journal.task` 读它；任务体由 OS 原生线程执行，
 * 因此"作业进度"是真实读数而不是占位（复检 AUD-G26）。
 */
object TaskRegistry {

    data class Task(
        val id: String,
        val kind: String,
        val state: String,
        val progress: Int,
        val startedAt: Long,
        val endedAt: Long?,
        val detail: String,
    )

    private const val CAP = 50

    private fun file(ctx: Context) = File(File(ctx.filesDir, "os"), "tasks.json")

    @Synchronized
    private fun load(ctx: Context): JSONArray = runCatching {
        val f = file(ctx)
        if (!f.exists()) JSONArray() else JSONArray(f.readText())
    }.getOrDefault(JSONArray())

    @Synchronized
    private fun save(ctx: Context, arr: JSONArray) {
        runCatching {
            val f = file(ctx)
            f.parentFile?.mkdirs()
            f.writeText(arr.toString())
        }
    }

    private fun toTask(o: JSONObject) = Task(
        id = o.optString("id"),
        kind = o.optString("kind"),
        state = o.optString("state", "running"),
        progress = o.optInt("progress", 0),
        startedAt = o.optLong("startedAt"),
        endedAt = if (o.has("endedAt")) o.optLong("endedAt") else null,
        detail = o.optString("detail"),
    )

    private fun toJson(t: Task) = JSONObject().apply {
        put("id", t.id)
        put("kind", t.kind)
        put("state", t.state)
        put("progress", t.progress)
        put("startedAt", t.startedAt)
        put("detail", t.detail)
        if (t.endedAt != null) put("endedAt", t.endedAt)
    }

    @Synchronized
    fun start(ctx: Context, kind: String): String {
        val id = kind + "-" + UUID.randomUUID().toString().substring(0, 8)
        val arr = load(ctx)
        arr.put(toJson(Task(id, kind, "running", 0, System.currentTimeMillis(), null, "已受理")))
        while (arr.length() > CAP) arr.remove(0)
        save(ctx, arr)
        return id
    }

    @Synchronized
    fun update(ctx: Context, id: String, state: String, progress: Int, detail: String) {
        val arr = load(ctx)
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("id") != id) continue
            o.put("state", state)
            o.put("progress", progress)
            o.put("detail", detail)
            if (state == "done" || state == "failed") o.put("endedAt", System.currentTimeMillis())
            break
        }
        save(ctx, arr)
    }

    @Synchronized
    fun finish(ctx: Context, id: String, ok: Boolean, detail: String) {
        update(ctx, id, if (ok) "done" else "failed", 100, detail)
    }

    @Synchronized
    fun list(ctx: Context, kind: String?, runningOnly: Boolean): List<Task> {
        val arr = load(ctx)
        val out = ArrayList<Task>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val t = toTask(o)
            if (kind != null && t.kind != kind) continue
            if (runningOnly && (t.state == "done" || t.state == "failed")) continue
            out.add(t)
        }
        return out
    }

    @Synchronized
    fun get(ctx: Context, id: String): Task? = list(ctx, null, false).lastOrNull { it.id == id }

    @Synchronized
    fun current(ctx: Context, kind: String?): Task? = list(ctx, kind, true).lastOrNull()
}
