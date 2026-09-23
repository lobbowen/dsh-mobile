package io.github.lobbowen.dshmobile.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 启动链归因：三态必须分开，尤其不能把「安装只落地一半」说成「从未安装」。
 */
class KernelResolutionTest {

    @Test fun 无CURRENT为从未安装() {
        val r = KernelResolution.resolve(null, null, entryExists = false)
        assertEquals(KernelResolution.State.ABSENT, r.state)
        assertFalse("无内核时 ok=false", r.ok)
        assertTrue(r.title.contains("尚无内核包"))
        assertTrue("应说明回落探针模式", r.detail.contains("探针模式"))
    }

    @Test fun 空白CURRENT等同缺失() {
        val r = KernelResolution.resolve("   ", "/x/bin/dsh-supervisor", entryExists = false)
        assertEquals(KernelResolution.State.ABSENT, r.state)
    }

    @Test fun 内核就位为READY() {
        val r = KernelResolution.resolve("0.1.0-android.11", "/data/files/kernel/0.1.0-android.11/bin/dsh-supervisor", true)
        assertEquals(KernelResolution.State.READY, r.state)
        assertTrue(r.ok)
        assertEquals("0.1.0-android.11", r.version)
        assertTrue(r.title.contains("0.1.0-android.11"))
        assertTrue("READY 的 detail 应给出入口路径", r.detail.contains("dsh-supervisor"))
    }

    @Test fun CURRENT在但入口缺失_必须报不完整而不是从未安装() {
        val r = KernelResolution.resolve("0.1.0-android.11", "/data/files/kernel/0.1.0-android.11/bin/dsh-supervisor", false)
        assertEquals(KernelResolution.State.INCOMPLETE, r.state)
        assertFalse(r.ok)
        assertTrue("标题应说明不完整", r.title.contains("不完整"))
        assertTrue("必须保留版本号（否则排查无从下手）", r.title.contains("0.1.0-android.11"))
        assertFalse("绝不能说成『尚未安装』——安装确实发生过", r.title.contains("尚未安装成功"))
        assertTrue("应给出正确的排查方向", r.detail.contains("install/verify"))
    }

    @Test fun 三种状态的ok标记各不相同() {
        assertTrue(KernelResolution.resolve("1.0", "/p", true).ok)
        assertFalse(KernelResolution.resolve("1.0", "/p", false).ok)
        assertFalse(KernelResolution.resolve(null, null, false).ok)
    }
}
