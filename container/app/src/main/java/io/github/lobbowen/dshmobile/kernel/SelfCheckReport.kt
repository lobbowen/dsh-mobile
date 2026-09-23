package io.github.lobbowen.dshmobile.kernel

/**
 * 自检报告的**纯逻辑**部分（统计 / 结论措辞 / 文本渲染）。
 *
 * 为什么需要它：验证整条内核链路此前只能"adb 拉文件下来看"，
 * 而目标设备的 **adb 是关闭的** —— 那份验证方式根本执行不了。
 * 正确做法是**设备自己自检、并把结论显示在界面上**。
 *
 * 抽成纯逻辑（不依赖 Android）是为了让"什么算绿"这件事本身可被钉住：
 * 三态（true=通过 / false=失败 / null=未知）必须分清 —— 把"未知"算成"通过"
 * 会让自检变成装饰。
 */
object SelfCheckReport {

    /** [ok] 为 null 表示"本次无法判定"（例如没网），它既不算通过也不算失败。 */
    data class Item(
        val id: String,
        val ok: Boolean?,
        val title: String,
        val detail: String = "",
    )

    fun passed(items: List<Item>): Int = items.count { it.ok == true }
    fun failed(items: List<Item>): Int = items.count { it.ok == false }
    fun unknown(items: List<Item>): Int = items.count { it.ok == null }

    /**
     * 一句话结论。
     *
     * 刻意规则：**只要有一项未知，就不能说"通过"** —— 否则"没测到"会被读成"没问题"。
     */
    fun verdict(items: List<Item>): String {
        if (items.isEmpty()) return "自检：无检查项"
        val total = items.size
        val f = failed(items)
        val u = unknown(items)
        return when {
            f == 0 && u == 0 -> "✅ 自检通过（" + total + "/" + total + "）"
            f == 0 -> "⚠ 自检 " + passed(items) + "/" + total + " 通过，另有 " + u + " 项未知（未测到 ≠ 没问题）"
            else -> "❌ 自检 " + passed(items) + "/" + total + " 通过，" + f + " 项失败" + if (u > 0) "，另有 " + u + " 项未知" else ""
        }
    }

    /** 渲染成可直接显示的文本。每项一行，符号区分通过/失败/未知。 */
    fun format(items: List<Item>): String {
        val sb = StringBuilder()
        sb.append(verdict(items)).append("\n")
        for (it in items) {
            val mark = when (it.ok) {
                true -> "✅"
                false -> "❌"
                null -> "❔"
            }
            sb.append(mark).append(" ").append(it.title)
            if (it.detail.isNotBlank()) sb.append("\n     ").append(it.detail)
            sb.append("\n")
        }
        return sb.toString()
    }
}
