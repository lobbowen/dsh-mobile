package lobos.os

import android.content.Context
import lobos.ota.ProgramManager
import org.json.JSONObject
import java.io.File

/**
 * Program 授权表的**唯一实现**（契约 §0「按 Program 授权」；复检 AUD-G35）。
 *
 * 事实源：已安装 Program 的包清单（`program-manifest.json`）的 `requires` ——
 * 里面是 `bridge:<group>` 组令牌。规则：
 *  - 握手未声明 program，或声明的 program 与清单 `name` 不符 → **只有 base**（空集）；
 *  - 相符 → 该 Program 声明的组（去 `bridge:` 前缀）。
 * 设备是否具备这些组再由 CapabilityBroker 的设备能力判一次（两道都过才放行）。
 */
object ProgramAuthorizer {

    fun manifestOf(ctx: Context): JSONObject? = runCatching {
        val pm = ProgramManager(ctx)
        val cur = pm.currentVersion() ?: return@runCatching null
        val f = File(pm.programDir(cur), "program-manifest.json")
        if (!f.exists()) null else JSONObject(f.readText())
    }.getOrNull()

    /** 该 Program 被授权的方法组（bare 名，不含 bridge: 前缀）。 */
    fun groupsFor(ctx: Context, programId: String?): Set<String> {
        val m = manifestOf(ctx) ?: return emptySet()
        val declared = m.optString("name", "")
        if (programId.isNullOrBlank()) return emptySet()
        if (declared.isNotBlank() && declared != programId) return emptySet()
        val arr = m.optJSONArray("requires") ?: return emptySet()
        return (0 until arr.length())
            .mapNotNull { arr.optString(it, "").takeIf { s -> s.isNotBlank() } }
            .map { it.removePrefix("bridge:") }
            .toSet()
    }
}
