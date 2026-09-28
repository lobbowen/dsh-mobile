package lobos.os

import android.content.Context
import org.json.JSONObject
import java.io.File

/** Program 元数据补丁（`files/os/program-settings.json`）—— `os.programs.settings` 的唯一存储。 */
object ProgramSettings {

    private fun file(ctx: Context) = File(File(ctx.filesDir, "os"), "program-settings.json")

    @Synchronized
    fun read(ctx: Context): JSONObject = runCatching {
        val f = file(ctx)
        if (!f.exists()) JSONObject() else JSONObject(f.readText())
    }.getOrDefault(JSONObject())

    @Synchronized
    fun patch(ctx: Context, id: String, patch: JSONObject): JSONObject {
        val all = read(ctx)
        val cur = all.optJSONObject(id) ?: JSONObject()
        patch.keys().forEach { k -> cur.put(k, patch.get(k)) }
        all.put(id, cur)
        runCatching {
            val f = file(ctx)
            f.parentFile?.mkdirs()
            f.writeText(all.toString())
        }
        return cur
    }
}
