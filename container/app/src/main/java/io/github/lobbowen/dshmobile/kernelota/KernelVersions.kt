package io.github.lobbowen.dshmobile.kernelota

/**
 * 内核版本比较 —— **纯 JVM**。
 *
 * 为什么单独成类：这套逻辑有**两份实现**（本文件与 container/engine/src/kernel-version.js），
 * 两者必须逐 token 等价，否则会出现"设备判不出更新"这类**静默**故障。
 * 抽成纯函数后，两侧可以共用同一份用例表（container/app/src/test/resources/kernel-version-cases.txt），
 * 任何一侧漂移都会让它自己的测试变红。
 *
 * 规则：数字段按数值比较，非数字段按字符串比较，逐 token 对齐；
 * 前缀相同时**更长的一方更大**（如 0.1.0-android.11 > 0.1.0-android）。
 */
object KernelVersions {

    fun compare(a: String, b: String): Int {
        val ta = Regex("\\d+|\\D+").findAll(a).map { it.value }.toList()
        val tb = Regex("\\d+|\\D+").findAll(b).map { it.value }.toList()
        for (i in 0 until maxOf(ta.size, tb.size)) {
            val x = ta.getOrNull(i) ?: return -1
            val y = tb.getOrNull(i) ?: return 1
            val nx = x.toLongOrNull()
            val ny = y.toLongOrNull()
            val c = when {
                nx != null && ny != null -> nx.compareTo(ny)
                nx != null -> 1
                ny != null -> -1
                else -> x.compareTo(y)
            }
            if (c != 0) return c
        }
        return 0
    }

    /** candidate 是否比 current 新（current 为 null 视为"尚未安装"→ 是）。 */
    fun isNewer(candidate: String, current: String?): Boolean =
        current == null || compare(candidate, current) > 0

    /** candidate 是否**低于版本下限**（下限为 null 视为未设 → 否）。 */
    fun isBelowFloor(candidate: String, floor: String?): Boolean =
        floor != null && compare(candidate, floor) < 0
}
