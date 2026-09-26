package io.github.lobbowen.dshmobile.kernelota

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
     * 「下载半包」一项的判据（纯逻辑，能被单测钉住）。
     *
     * 三条口径，都是被真机报告逼出来的：
     *  ① **半包不是失败**。跨启动保留并续传是设计（docs/runbook/kernel-ota.md「绝不删半包」），
     *     把它算成失败就得到「自检 6/7 通过」这种假红 —— 假红和假绿一样贵：它把真红一起稀释掉。
     *  ② 唯一真失败 = **0 字节的半包**：里面没有任何可续传的东西，只是我们留下的空壳。
     *  ③ 暂存目录（[staging]）由开机清扫负责；自检看到它只可能是「一次安装正在进行」，
     *     所以只陈列、不据此判红。
     */
    fun partialItem(parts: List<Pair<String, Long>>, staging: List<String> = emptyList()): Item {
        val hollow = parts.filter { it.second <= 0L }.map { it.first }
        val detail = buildString {
            append(
                if (parts.isEmpty()) "无半包（没有中断过的下载）"
                else "半包会被续传（非错误）：" + parts.joinToString(", ") { "${it.first}=${it.second}B" }
            )
            if (staging.isNotEmpty()) append("   安装正在进行（暂存）：" + staging.joinToString(", "))
            if (hollow.isNotEmpty()) append("   无可续传内容的空半包：" + hollow.joinToString(", "))
        }
        return Item("partial", hollow.isEmpty(), "下载半包", detail)
    }

    /**
     * 整份自检的三态结论，供诊断落盘用。
     *
     * 界面读 [verdict]（会说"另有 N 项未知"），日志若按"零失败即通过"记录，
     * 同一份自检就会在两个出口给出两个结论 —— 未知在哪个出口都不算通过。
     */
    fun overallOk(items: List<Item>): Boolean? = when {
        items.isEmpty() -> null
        failed(items) > 0 -> false
        unknown(items) > 0 -> null
        else -> true
    }

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
