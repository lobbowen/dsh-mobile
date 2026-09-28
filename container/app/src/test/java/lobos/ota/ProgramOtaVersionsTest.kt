package lobos.ota

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 版本比较的**跨语言共享用例**（Kotlin 侧）。
 *
 * 用例表在 src/test/resources/system-version-cases.txt，
 * container/engine 的 program-version-crosslang-test.js **读同一份文件**。
 * 两份实现（Kotlin 的 ProgramOtaVersions 与 JS 的 program-version.js）必须逐条一致 ——
 * 此前这个"必须等价"只写在注释里，靠人眼保证，是最容易静默分叉的地方：
 * 一旦分叉，后果是"设备判不出更新"或"把旧版判成新版"。
 */
class ProgramOtaVersionsTest {

    private fun cases(): List<Triple<String, String, Int>> {
        val text = javaClass.getResourceAsStream("/system-version-cases.txt")
            ?.bufferedReader()?.use { it.readText() }
            ?: error("找不到共享用例表 /system-version-cases.txt（它必须打进测试资源）")
        return text.lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .map { line ->
                val p = line.split("|")
                require(p.size == 3) { "用例格式错误（应为 a|b|expected）: " + line }
                Triple(p[0], p[1], p[2].trim().toInt())
            }
    }

    @Test
    fun 用例表非空且全部满足共享契约() {
        val cs = cases()
        assertTrue("用例表不该这么小", cs.size >= 15)
        val bad = mutableListOf<String>()
        for ((a, b, expected) in cs) {
            val got = Math.signum(ProgramOtaVersions.compare(a, b).toDouble()).toInt()
            if (got != expected) bad.add("compare(\"$a\", \"$b\") 期望 $expected 得到 $got")
        }
        assertEquals("与共享用例表不一致:\n" + bad.joinToString("\n"), emptyList<String>(), bad)
    }

    @Test
    fun 比较是反对称的() {
        for ((a, b, expected) in cases()) {
            if (expected == 0) continue
            val rev = Math.signum(ProgramOtaVersions.compare(b, a).toDouble()).toInt()
            assertEquals("compare 不反对称: $a vs $b", -expected, rev)
        }
    }

    @Test
    fun isNewer_未安装时视为需要安装() {
        assertTrue(ProgramOtaVersions.isNewer("0.1.0", null))
        assertTrue(ProgramOtaVersions.isNewer("0.1.0-android.11", "0.1.0-android.2"))
        assertFalse("相等不应判为更新", ProgramOtaVersions.isNewer("1.0.0", "1.0.0"))
        assertFalse(ProgramOtaVersions.isNewer("0.1.0-android.2", "0.1.0-android.11"))
    }

    @Test
    fun isBelowFloor_未设下限时从不拒绝() {
        assertFalse(ProgramOtaVersions.isBelowFloor("0.0.1", null))
        assertTrue(ProgramOtaVersions.isBelowFloor("0.1.0-android.2", "0.1.0-android.11"))
        assertFalse("相等不算低于", ProgramOtaVersions.isBelowFloor("0.1.0-android.11", "0.1.0-android.11"))
    }
}
