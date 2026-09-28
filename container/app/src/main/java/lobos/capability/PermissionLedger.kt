package lobos.capability

import android.content.Context
import lobos.permissions.PermissionCatalog
import org.json.JSONObject
import java.io.File

/**
 * 权限实测账（`files/os/permission-ledger.json`）：「adb 在这台机上到底把这项开开了没有」的**唯一落盘处**。
 *
 * 为什么要一本账而不是每次现推：
 *  - 旧实现按档位预先判死（AppOps 除电池外一律「只能人点」），于是那三项**从没被试过**就先被记成
 *    人点项，被真机定罪为「未试先判」（债表 SP-1）。账本把结论的来源从档位换成实测结果。
 *  - 「这台手机的 adb 能开哪些权限」是设备事实，跨进程重启仍然成立；只在内存里记就等于每开一次屏
 *    就把同一句 `appops set` 再撞一次，用户看到的是重复弹页。
 *  - 静默失败之后必须**回落成人点**（flow-spec §2.2「不许静默吞掉」），回落的依据就是一个在册的结局。
 *
 * 只存事实不存判据：判据一律读系统侧回读（[lobos.permissions.PermissionCenter]），这本账只回答
 * 「这条路 adb 走过、结果如何」。两者冲突时以回读为准 —— 账上说开了而系统说没开，就是没开。
 */
object PermissionLedger {

    private fun file(ctx: Context) = File(File(ctx.filesDir, "os"), "permission-ledger.json")

    /** 读全部在册结局；账本里的陌生 id / 坏值一律跳过（废止的档位不许复活成读数）。 */
    fun readAll(ctx: Context): Map<String, SilentAttempt> = runCatching {
        val f = file(ctx)
        if (!f.exists()) return emptyMap()
        val root = JSONObject(f.readText())
        val out = LinkedHashMap<String, SilentAttempt>()
        val keys = root.keys()
        while (keys.hasNext()) {
            val id = keys.next()
            if (PermissionCatalog.byId(id) == null) continue
            val entry = root.optJSONObject(id) ?: continue
            val outcome = AttemptOutcome.values().firstOrNull { it.name == entry.optString("outcome") }
                ?: continue
            out[id] = SilentAttempt(outcome, entry.optLong("atMs", 0L), entry.optString("detail"))
        }
        out
    }.getOrDefault(emptyMap())

    /**
     * 记一笔实测结局。**命令没跑到 shell 时不许调用本方法**（[AttemptOutcomeRule.of] 返回 null
     * 就是这种情况）：通道死了不是这条路的能力事实。
     */
    @Synchronized
    fun record(ctx: Context, id: String, outcome: AttemptOutcome, detail: String) {
        runCatching {
            val f = file(ctx)
            val root = if (f.exists()) JSONObject(f.readText()) else JSONObject()
            root.put(
                id,
                JSONObject()
                    .put("outcome", outcome.name)
                    .put("atMs", System.currentTimeMillis())
                    .put("detail", detail.take(300)),
            )
            f.parentFile?.mkdirs()
            f.writeText(root.toString())
        }
    }
}
