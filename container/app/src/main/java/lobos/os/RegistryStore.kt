package lobos.os

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 镜像源登记（`files/os/registry.json`）—— 契约 `os.registry.*` 的唯一存储（复检 AUD-G26）。
 *
 * 只有"当前源 + 最近一次探活读数"两件事：不假装有测速历史，也不缓存候选源列表。
 */
object RegistryStore {

    private fun file(ctx: Context) = File(File(ctx.filesDir, "os"), "registry.json")

    @Synchronized
    private fun read(ctx: Context): JSONObject = runCatching {
        val f = file(ctx)
        if (!f.exists()) JSONObject() else JSONObject(f.readText())
    }.getOrDefault(JSONObject())

    @Synchronized
    fun info(ctx: Context): JSONObject {
        val o = read(ctx)
        return JSONObject().apply {
            put("origin", o.optString("origin", ""))
            put("updatedAt", o.optLong("updatedAt", 0L))
            put("probe", o.optJSONObject("probe") ?: JSONObject.NULL)
            put("programs", JSONObject.NULL)
        }
    }

    @Synchronized
    fun setOrigin(ctx: Context, origin: String, probe: JSONObject?): JSONObject {
        val o = read(ctx)
        o.put("origin", origin)
        o.put("updatedAt", System.currentTimeMillis())
        if (probe != null) o.put("probe", probe)
        runCatching {
            val f = file(ctx)
            f.parentFile?.mkdirs()
            f.writeText(o.toString())
        }
        return info(ctx)
    }

    /** 单源探活：HEAD 计时（3s 超时）；失败也是读数，不抛。 */
    fun probe(origin: String): JSONObject {
        val started = System.currentTimeMillis()
        return try {
            val c = URL(origin).openConnection() as HttpURLConnection
            c.requestMethod = "HEAD"
            c.connectTimeout = 3000
            c.readTimeout = 3000
            c.instanceFollowRedirects = true
            val code = c.responseCode
            c.disconnect()
            JSONObject().apply {
                put("ok", code in 200..399)
                put("code", code)
                put("latencyMs", System.currentTimeMillis() - started)
            }
        } catch (e: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("code", 0)
                put("latencyMs", System.currentTimeMillis() - started)
                put("error", e::class.java.simpleName)
            }
        }
    }
}
