package lobos.os

import android.content.Context
import java.io.File
import org.json.JSONObject

/**
 * PortBroker：Program 端口由 OS 分配（架构 v4 §6，债 A11/A12；SYSTEM-API §2.4）。
 * 最小实现：确定性分配 + 落盘登记；反代由 console Program 承担，分配权只在 OS。
 */
object PortBroker {

    private const val DIR = "os"
    private const val FILE = "ports.json"
    const val RANGE_START = 41000
    const val RANGE_END = 41999

    data class Lease(val port: Int, val owner: String)

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
    fun list(ctx: Context): List<Lease> {
        val obj = root(ctx)
        val names = obj.names() ?: return emptyList()
        return (0 until names.length()).mapNotNull { i ->
            val owner = names.optString(i)
            val port = obj.optInt(owner, 0)
            if (port == 0) null else Lease(port, owner)
        }
    }

    /** 为 owner 分配（或复用）端口；0 表示无可用端口。 */
    @Synchronized
    fun claim(ctx: Context, owner: String, preferred: Int? = null): Int {
        val obj = root(ctx)
        obj.optInt(owner, 0).takeIf { it != 0 }?.let { return it }
        val used = list(ctx).map { it.port }.toSet()
        val port = preferred?.takeIf { it in RANGE_START..RANGE_END && it !in used }
            ?: (RANGE_START..RANGE_END).firstOrNull { it !in used }
            ?: return 0
        obj.put(owner, port)
        persist(ctx, obj)
        Journal.append(ctx, "ports", null, "claim " + owner + " -> " + port)
        return port
    }

    @Synchronized
    fun release(ctx: Context, owner: String) {
        val obj = root(ctx)
        if (obj.has(owner)) {
            obj.remove(owner)
            persist(ctx, obj)
            Journal.append(ctx, "ports", null, "release " + owner)
        }
    }
}
