package io.github.lobbowen.dshmobile.kernelota

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    // ── 「下载半包」判据（真机 2026-09-26 定罪的假红） ──────────────────────
    // 会红的改动：把半包重新算成失败（→「自检 6/7 通过」那种假红回来）、
    // 把 0 字节空壳算成可续传（→ 真失败被洗白）、据此对暂存目录判红。

    private fun p(name: String, bytes: Long) = name to bytes

    @Test fun 无半包是干净状态不算失败() {
        val it = SelfCheckReport.partialItem(emptyList())
        assertEquals(true, it.ok)
        assertTrue(it.detail.contains("无半包"))
    }

    @Test fun 有内容的半包只陈列不判红() {
        val it = SelfCheckReport.partialItem(listOf(p("kernel-ota-0.1.0-android.13.zip.part", 4096L)))
        assertTrue("半包会被续传，判红就是假红: " + it.detail, it.ok == true)
        assertTrue(it.detail.contains("非错误"))
        assertTrue("必须把进度报出来: " + it.detail, it.detail.contains("4096B"))
    }

    @Test fun 零字节空壳是唯一真失败() {
        val it = SelfCheckReport.partialItem(listOf(p("kernel-ota-0.1.0-android.13.zip.part", 0L)))
        assertEquals(false, it.ok)
        assertTrue(it.detail.contains("空半包"))
    }

    @Test fun 混合时只把空壳列为失败() {
        val it = SelfCheckReport.partialItem(
            listOf(p("good.part", 2048L), p("empty.part", 0L)),
        )
        assertEquals(false, it.ok)
        assertTrue("失败清单里只许有空壳: " + it.detail, it.detail.contains("空半包：empty.part"))
        assertFalse("可续传的半包不该被算进失败: " + it.detail, it.detail.contains("空半包：good.part"))
    }

    @Test fun 暂存目录只陈列绝不判红() {
        val it = SelfCheckReport.partialItem(
            emptyList(),
            listOf("0.1.0-android.13.tmp-12345-1690000000000"),
        )
        assertTrue("一次正在进行的安装不该算失败", it.ok == true)
        assertTrue(it.detail.contains("安装正在进行"))
    }

    @Test fun 半包项不再把整份自检拖成假红() {
        val items = listOf(i(true, "feed-config"), i(true, "manifest-reachable"), SelfCheckReport.partialItem(listOf(p("a.part", 512L))))
        val v = SelfCheckReport.verdict(items)
        assertTrue("全绿就该说通过，不该出现 2/3 这种口径: " + v, v.contains("自检通过"))
        assertTrue(v.contains("3/3"))
    }

    @Test fun 诊断落盘的总结论把未知算成不通过() {
        // 界面会说"另有 N 项未知"，日志若按"零失败即通过"记录 = 同一份自检两个结论。
        val allGreen = SelfCheckReport.overallOk(listOf(i(true, "a"), i(true, "b")))
        val anyFail = SelfCheckReport.overallOk(listOf(i(true, "a"), i(false, "b")))
        val anyUnknown = SelfCheckReport.overallOk(listOf(i(true, "a"), i(null, "b")))
        assertTrue("全绿才算通过，实际 $allGreen", allGreen == true)
        assertTrue("有失败必须算失败，实际 $anyFail", anyFail == false)
        assertNull("有未知既不算通过也不算失败", anyUnknown)
        assertNull("一项都没测到时不许默认绿", SelfCheckReport.overallOk(emptyList()))
    }
}
