package io.github.lobbowen.dshmobile.kernel

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 内核状态机（CURRENT / FLOOR / PENDING）—— ADR-0005 C1/C2 的存储层。
 *
 * 重点验证两件"安全承诺"：
 *   ① FLOOR **只增不减**（否则反回滚失效）
 *   ② 回滚**不动 FLOOR**（否则"回滚"变成降级的后门）
 */
class KernelStateStoreTest {

    private lateinit var root: File

    @Before fun setUp() { root = Files.createTempDirectory("kstate").toFile() }
    @After fun tearDown() { root.deleteRecursively() }

    private fun store() = KernelStateStore(root)

    @Test fun 下限只增不减() {
        val s = store()
        assertNull("初始无下限", s.floorVersion())
        s.setFloor("0.1.0-android.2")
        assertEquals("0.1.0-android.2", s.floorVersion())
        s.setFloor("0.1.0-android.11")
        assertEquals("0.1.0-android.11", s.floorVersion())
        s.setFloor("0.1.0-android.2")                       // 更低 → 必须被忽略
        assertEquals("更低的值绝不允许把下限拉回去", "0.1.0-android.11", s.floorVersion())
        s.setFloor("0.1.0-android.11")                      // 相等 → 也忽略（不必重写）
        assertEquals("0.1.0-android.11", s.floorVersion())
    }

    @Test fun 低于下限判为真_等于不算低于() {
        val s = store()
        assertFalse("未设下限时从不拒绝", s.isBelowFloor("0.0.1"))
        s.setFloor("0.1.0-android.11")
        assertTrue(s.isBelowFloor("0.1.0-android.2"))
        assertTrue(s.isBelowFloor("0.1.0-android.10"))
        assertFalse("等于下限不算低于（否则自己都装不上）", s.isBelowFloor("0.1.0-android.11"))
        assertFalse(s.isBelowFloor("0.2.0"))
    }

    @Test fun pending往返与清除() {
        val s = store()
        assertNull(s.pending())
        s.markPending("0.2.0", "0.1.0-android.11")
        assertEquals("0.2.0", s.pending()?.version)
        assertEquals("0.1.0-android.11", s.pending()?.from)
        s.clearPending()
        assertNull("清除后必须真的取不到", s.pending())
    }

    @Test fun pending_无来源版本时from为null() {
        val s = store()
        s.markPending("0.2.0", null)
        assertEquals("0.2.0", s.pending()?.version)
        assertNull("首次安装没有 from", s.pending()?.from)
    }

    @Test fun current原子写与读取() {
        val s = store()
        assertNull(s.currentVersion())
        s.setCurrentVersion("0.1.0-android.11")
        assertEquals("0.1.0-android.11", s.currentVersion())
        s.setCurrentVersion("0.2.0")
        assertEquals("0.2.0", s.currentVersion())
    }

    @Test fun 回滚_仅当目标目录存在() {
        val s = store()
        s.setCurrentVersion("v1")
        assertFalse("目录不存在时不该回滚（否则 CURRENT 指向不存在的版本）", s.rollbackTo("v2"))
        assertEquals("失败的强转不该改变现状", "v1", s.currentVersion())
        File(root, "v2").mkdirs()
        assertTrue(s.rollbackTo("v2"))
        assertEquals("v2", s.currentVersion())
    }

    @Test fun 回滚不改动下限() {
        val s = store()
        File(root, "old").mkdirs()
        s.setFloor("0.1.0-android.11")
        s.setCurrentVersion("0.1.0-android.11")
        assertTrue(s.rollbackTo("old"))
        assertEquals("old", s.currentVersion())
        assertEquals("回滚后下限必须保持 —— 否则回滚就是降级的后门", "0.1.0-android.11", s.floorVersion())
        assertTrue("回滚之后，比下限旧的包依旧装不上", s.isBelowFloor("0.1.0-android.2"))
    }
}
