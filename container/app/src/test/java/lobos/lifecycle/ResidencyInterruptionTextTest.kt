package lobos.lifecycle

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 常驻中断首行文案的判据（债 E11）。
 *
 * 这一格原来的形状是：不管上一次怎么死的，文案都补同一句「锚掉=判决降级=即将被杀」。
 * 三条判据因此永远只能拿到一个答案，而「锚掉」明明是另一条边**当场观测**到的事
 * （`OsHostService.observeAnchorTransition`）—— 事后拿它当归因，等于把猜测印成取证。
 * 现在归因整段由外面递进来（`KillAudit.attribute`），这里只钉两件事：
 * 该不归因的那一支必须真的不带归因，该带的那一支必须把取到的原样带出来。
 */
class ResidencyInterruptionTextTest {

    @Test fun 设备重启那一支不补死因() {
        val t = ResidencyAudit.interruptionText(
            lastAliveAt = "23:41:07", gapText = "12 分 3 秒",
            deviceReboot = true, attribution = "死因=o-kill（系统退出记录 …）",
        )
        assertTrue(t, t.contains("设备重启"))
        // 重启时系统里那条退出记录不代表 App 被回收；把它印到文案里就是冤枉 OEM 杀了常驻。
        assertFalse(t, t.contains("死因"))
        assertFalse(t, t.contains("常驻被打断"))
    }

    @Test fun 被打断那一支把取到的归因原样带出_取不到也不补猜测() {
        val forensics = ResidencyAudit.interruptionText(
            lastAliveAt = "23:41:07", gapText = "12 分 3 秒",
            deviceReboot = false, attribution = "死因=o-kill（系统退出记录 reason=13 desc=o-kill(4008)）",
        )
        assertTrue(forensics, forensics.contains("常驻被打断"))
        assertTrue(forensics, forensics.contains("死因=o-kill"))
        assertTrue(forensics, forensics.contains("本设计不提供死后恢复"))
        // 「未取证」那一支同样不许出现「锚掉」：这里没有任何一处把机制写成常量。
        val none = ResidencyAudit.interruptionText(
            lastAliveAt = "23:41:07", gapText = "12 分 3 秒",
            deviceReboot = false, attribution = "死因未取证（读系统退出史失败（binder 调用没答上来））",
        )
        assertTrue(none, none.contains("死因未取证"))
        assertFalse(none, none.contains("锚掉"))
        assertFalse(none, none.contains("判决降级"))
    }
}
