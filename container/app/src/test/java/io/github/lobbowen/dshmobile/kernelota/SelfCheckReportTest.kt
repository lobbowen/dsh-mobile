package io.github.lobbowen.dshmobile.kernelota

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "什么算绿"本身必须可被钉住 —— 尤其"未知"绝不能算通过。
 */
class SelfCheckReportTest {

    private fun i(ok: Boolean?, t: String = "x") = SelfCheckReport.Item(t, ok, t)

    @Test fun 全通过才算通过() {
        val all = listOf(i(true, "a"), i(true, "b"))
        assertTrue(SelfCheckReport.verdict(all).contains("自检通过"))
        assertEquals(2, SelfCheckReport.passed(all))
        assertEquals(0, SelfCheckReport.failed(all))
        assertEquals(0, SelfCheckReport.unknown(all))
    }

    @Test fun 未知不得被读成通过() {
        val mixed = listOf(i(true, "a"), i(null, "b"))
        val v = SelfCheckReport.verdict(mixed)
        assertTrue("有未知项时不能说通过: " + v, !v.contains("自检通过"))
        assertTrue("应显式说明有未知项: " + v, v.contains("未知"))
        assertTrue("应说明未测到不等于没问题", v.contains("未测到"))
    }

    @Test fun 有失败时列出失败数() {
        val bad = listOf(i(true, "a"), i(false, "b"), i(false, "c"))
        val v = SelfCheckReport.verdict(bad)
        assertTrue(v.contains("2 项失败"))
        assertEquals(2, SelfCheckReport.failed(bad))
    }

    @Test fun 失败与未知并存时两者都要说() {
        val v = SelfCheckReport.verdict(listOf(i(false), i(null)))
        assertTrue(v.contains("失败"))
        assertTrue(v.contains("未知"))
    }

    @Test fun 空列表不崩且不误报通过() {
        val v = SelfCheckReport.verdict(emptyList())
        assertTrue(v.contains("无检查项"))
    }

    @Test fun 渲染用三种符号区分三态() {
        val text = SelfCheckReport.format(listOf(i(true, "甲"), i(false, "乙"), i(null, "丙")))
        assertTrue(text.contains("✅ 甲"))
        assertTrue(text.contains("❌ 乙"))
        assertTrue(text.contains("❔ 丙"))
    }

    @Test fun 详情为空时不产生空行缩进() {
        val noDetail = SelfCheckReport.Item("a", true, "无详情", "")
        val text = SelfCheckReport.format(listOf(noDetail))
        assertTrue("空 detail 不应产生缩进行", !text.contains("\n     \n"))
    }
}
