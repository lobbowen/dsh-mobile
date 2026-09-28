package lobos.os

import android.content.Context
import java.io.File
import org.json.JSONObject

/**
 * AppRegistry：Program 目录 / 版本 / 期望态（架构 v4 §3/§9；SYSTEM-API §2.3）。
 * 期望态是 OS 的唯一真相：只有 desired=RUNNING 的实例才允许跑，其余冻结。
 */
object AppRegistry {

    private const val DIR = "os"
    private const val FILE = "programs.json"

    enum class Desired { RUNNING, STOPPED, FROZEN }

    data class Entry(
        val id: String,
        val version: String?,
        val role: String,
        val desired: Desired,
        val port: Int?,
    )

    private fun file(ctx: Context): File {
        val d = File(ctx.filesDir, DIR)
        d.mkdirs()
        return File(d, FILE)
    }

    @Synchronized
    private fun root(ctx: Context): JSONObject =
        runCatching { JSONObject(file(ctx).readText()) }.getOrDefault(JSONObject())

    @Synchronized
    private fun persist(ctx: Context, obj: JSONObject) {
        runCatching { file(ctx).writeText(obj.toString(2)) }
    }

    @Synchronized
    fun all(ctx: Context): List<Entry> {
        val obj = root(ctx)
        val names = obj.names() ?: return emptyList()
        return (0 until names.length()).mapNotNull { i ->
            val id = names.optString(i)
            val o = obj.optJSONObject(id) ?: return@mapNotNull null
            Entry(
                id = id,
                version = o.optString("version").takeIf { it.isNotBlank() },
                role = o.optString("role", "agent"),
                desired = runCatching { Desired.valueOf(o.optString("desired", "STOPPED")) }
                    .getOrDefault(Desired.STOPPED),
                port = o.optInt("port", 0).takeIf { it != 0 },
            )
        }
    }

    @Synchronized
    fun upsert(ctx: Context, entry: Entry) {
        val obj = root(ctx)
        obj.put(entry.id, JSONObject().apply {
            put("version", entry.version ?: "")
            put("role", entry.role)
            put("desired", entry.desired.name)
            if (entry.port != null) put("port", entry.port)
        })
        persist(ctx, obj)
        Journal.append(ctx, "registry", null, "upsert " + entry.id + " desired=" + entry.desired.name)
    }

    @Synchronized
    fun remove(ctx: Context, id: String) {
        val obj = root(ctx)
        obj.remove(id)
        persist(ctx, obj)
        Journal.append(ctx, "registry", null, "remove " + id)
    }

    /** 控制面板 Program 的固定 id：停用 console 后 OS 仍能启动/被管理（A12/D5）。 */
    fun consoleId(): String = "console"
}
