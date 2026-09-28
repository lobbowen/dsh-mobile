package lobos.ota

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 启动链归因：三态必须分开，尤其不能把「安装只落地一半」说成「从未安装」。
 */
class ProgramOtaResolutionTest {

    @Test fun 无CURRENT为从未安装() {
        val r = ProgramOtaResolution.resolve(null, null, entryExists = false)
        assertEquals(ProgramOtaResolution.State.ABSENT, r.state)
        assertFalse("无内核时 ok=false", r.ok)
        assertTrue(r.title.contains("尚无内核包"))
        assertTrue("必须如实说不启动运行时", r.detail.contains("不启动运行时"))
    }

    @Test fun 空白CURRENT等同缺失() {
        val r = ProgramOtaResolution.resolve("   ", "/x/bin/panel", entryExists = false)
        assertEquals(ProgramOtaResolution.State.ABSENT, r.state)
    }

    @Test fun 内核就位为READY() {
        val r = ProgramOtaResolution.resolve("0.1.0-android.11", "/data/files/programs/console/0.1.0-android.11/bin/panel", true)
        assertEquals(ProgramOtaResolution.State.READY, r.state)
        assertTrue(r.ok)
        assertEquals("0.1.0-android.11", r.version)
        assertTrue(r.title.contains("0.1.0-android.11"))
        assertTrue("READY 的 detail 应给出入口路径", r.detail.contains("panel"))
    }

    @Test fun CURRENT在但入口缺失_必须报不完整而不是从未安装() {
        val r = ProgramOtaResolution.resolve("0.1.0-android.11", "/data/files/programs/console/0.1.0-android.11/bin/panel", false)
        assertEquals(ProgramOtaResolution.State.INCOMPLETE, r.state)
        assertFalse(r.ok)
        assertTrue("标题应说明不完整", r.title.contains("不完整"))
        assertTrue("必须保留版本号（否则排查无从下手）", r.title.contains("0.1.0-android.11"))
        assertFalse("绝不能说成『尚未安装』——安装确实发生过", r.title.contains("尚未安装成功"))
        assertTrue("应给出正确的排查方向", r.detail.contains("install/verify"))
    }

    @Test fun 三种状态的ok标记各不相同() {
        assertTrue(ProgramOtaResolution.resolve("1.0", "/p", true).ok)
        assertFalse(ProgramOtaResolution.resolve("1.0", "/p", false).ok)
        assertFalse(ProgramOtaResolution.resolve(null, null, false).ok)
    }

    @Test fun 非READY绝不承诺回落探针() {
        // 真机定罪的假绿：无内核时去 spawn 随包 server.js 探针，探针点亮端口被算成「启动成功」。
        // 探针已降格为诊断页显式驱动的诊断件，所以归因文本里不许再出现「回落」这条路。
        for (r in listOf(
            ProgramOtaResolution.resolve(null, null, entryExists = false),
            ProgramOtaResolution.resolve("0.1.0-android.11", "/p/bin/panel", entryExists = false),
        )) {
            assertFalse(r.state.name + " 不该承诺回落探针", r.detail.contains("回落"))
            assertFalse(r.state.name + " 非 READY 就不该有可跑的东西", r.ok)
        }
    }
}
