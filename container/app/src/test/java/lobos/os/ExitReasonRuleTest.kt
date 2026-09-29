package lobos.os

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 退出史归因 golden（债 E11）。
 *
 * 钉的是「一条系统退出记录 -> 用户看到的那句死因」这条纯函数。它此前不可测不是因为难，
 * 而是因为**根本没有输入**：采集走 `dumpsys`（app uid 无 DUMP 权限，永远读不到），文案于是
 * 写死成一句机制猜测。2026-09-30 的真机读数（PLP120 / API 37）给出下面这些**真实存在**的口径，
 * 它们中的任何一条在旧写法下都会被归成同一句「锚掉=判决降级=即将被杀」。
 *
 * 判据住在 [Journal.Reason.fromExitInfo] 与 [KillAudit.attribute]，与 Android 细节无关；
 * 落盘与通知渲染（Journal / ResidencyAudit）不可由 JVM 测，所以判据必须能拔出来住在这儿。
 */
class ExitReasonRuleTest {

    private val main = "lobos.app"

    private fun rec(
        atMs: Long = 1_000L,
        process: String = main,
        reason: Int,
        importance: Int = 300,
        description: String? = null,
    ) = KillAudit.ExitRecord(
        atMs = atMs,
        pid = 1000,
        process = process,
        reason = reason,
        importance = importance,
        description = description,
    )

    @Test fun 真机口径逐条归因_不共用一句猜测() {
        // 这一组 description 取自本机 adb 域留档（docs/plans/os-v4-execution-plan.md:14、
        // docs/adr/0010-lob-os-container-form.md:12）。ColorOS 把真凶只写在描述里，数值 reason
        // 一律停在 13（AOSP REASON_OTHER）—— 所以「按描述优先、数值码兜底」不是偏好，是实测。
        assertEquals(Journal.Reason.OEM_KILL, Journal.Reason.fromExitInfo(13, "o-kill(4008)"))
        assertEquals(Journal.Reason.OEM_KILL, Journal.Reason.fromExitInfo(13, "o-kill(6008)"))
        assertEquals(Journal.Reason.OEM_BG_LIMIT, Journal.Reason.fromExitInfo(13, "bgLimit_level_thermal_10"))
        assertEquals(Journal.Reason.LOW_MEMORY, Journal.Reason.fromExitInfo(13, "Cached(lowmem)[(cch-empty)]"))
        assertEquals(Journal.Reason.LOW_MEMORY, Journal.Reason.fromExitInfo(13, "NonUi(lowmem)[(service)]"))
        assertEquals(Journal.Reason.USER_STOPPED, Journal.Reason.fromExitInfo(13, "Force stop com.x"))
        assertEquals(Journal.Reason.SELF_EXIT, Journal.Reason.fromExitInfo(1, "exit_self_1012_0"))
        // 描述没有信息时才轮到数值码（AOSP ApplicationExitInfo.REASON_* 的号）。
        assertEquals(Journal.Reason.CRASH, Journal.Reason.fromExitInfo(4, null))
        assertEquals(Journal.Reason.CRASH, Journal.Reason.fromExitInfo(5, "native crash"))
        assertEquals(Journal.Reason.ANR, Journal.Reason.fromExitInfo(6, null))
        assertEquals(Journal.Reason.PERMISSION_CHANGED, Journal.Reason.fromExitInfo(8, null))
        assertEquals(Journal.Reason.PACKAGE_CHANGED, Journal.Reason.fromExitInfo(15, null))
        assertEquals(Journal.Reason.PACKAGE_CHANGED, Journal.Reason.fromExitInfo(16, null))
        assertEquals(Journal.Reason.FREEZER, Journal.Reason.fromExitInfo(14, null))
        assertEquals(Journal.Reason.USER_STOPPED, Journal.Reason.fromExitInfo(11, null))
    }

    @Test fun AOSP的subreason名经描述文本接管() {
        // getSubReason() 是 @hide，app 侧拿不到号；但 getDescription() 会把系统认识的 subreason
        // 以 `[NAME]` 前缀拼进描述（AOSP android15-release ApplicationExitInfo.java:785-802 拼法、
        // :1351-1396 名表）。这几条就是那条通道的产物，判据必须接得住，否则它们会全落 UNKNOWN。
        assertEquals(Journal.Reason.USER_STOPPED, Journal.Reason.fromExitInfo(13, "[FORCE STOP]"))
        assertEquals(Journal.Reason.USER_STOPPED, Journal.Reason.fromExitInfo(13, "[REMOVE TASK]"))
        assertEquals(Journal.Reason.FREEZER, Journal.Reason.fromExitInfo(13, "[FREEZER BINDER TRANSACTION]"))
        // OEM 自己的号在 AOSP 名表里没有名字，subreasonToString 退 "UNKNOWN" ⇒ 前缀变成 [UNKNOWN]，
        // 但真凶词还在正文里：前缀不许把归因带跑，也不许因为「带 UNKNOWN」就判成未归因。
        assertEquals(Journal.Reason.OEM_KILL, Journal.Reason.fromExitInfo(13, "[UNKNOWN] o-kill(4008)"))
    }

    @Test fun 认不出的读数落UNKNOWN_且原始数字随读数可见() {
        // 公开 REASON_* 常量表止于 16（android15-release :65-183），更高版本会加码。
        // 猜它是哪个凶手=伪造事实，所以判据只说「未归因」，而把号码留在读数里 ——
        // 台账可见，人才补得了词表。这里给一个表外的号当对照，不代表本机见过它。
        val r = rec(reason = 27, description = "some future system wording")
        assertEquals(Journal.Reason.UNKNOWN, r.verdict)
        assertTrue(r.detail(), r.detail().contains("reason=27"))
        assertTrue(r.detail(), r.detail().contains("some future system wording"))
        // 系统认识而词表不认的名（ISOLATED NOT NEEDED）同样不猜凶手。
        val iso = rec(reason = 13, description = "[ISOLATED NOT NEEDED]")
        assertEquals(Journal.Reason.UNKNOWN, iso.verdict)
        assertTrue(iso.detail(), iso.detail().contains("[ISOLATED NOT NEEDED]"))
    }

    @Test fun 归因只认主进程_兄弟进程的死不算常驻断了() {
        val exits = listOf(
            rec(atMs = 5_000L, process = "$main:render", reason = 3),
            rec(atMs = 4_000L, reason = 13, description = "o-kill(4008)"),
        )
        val line = KillAudit.attribute(exits, null, 1_000L, main)
        assertTrue(line, line.contains("o-kill"))
        assertFalse("更晚的那条是别的进程，不能拿来归因：" + line, line.contains("死因=lowMemory"))
    }

    @Test fun 早于本次心跳的记录不冒充这次中断() {
        // 上次存活到 9_000，而退出史里最新的一条发生在 2_000 —— 那是**上一次**中断的账。
        val exits = listOf(rec(atMs = 2_000L, reason = 13, description = "o-kill(4008)"))
        val line = KillAudit.attribute(exits, null, 9_000L, main)
        assertTrue(line, line.startsWith("死因未取证"))
        assertFalse(line, line.contains("o-kill"))
    }

    @Test fun 取不到就说不取证_绝不退成没被杀() {
        // 三种「取不到」各有名字：读失败、系统不提供、这次还没读到。都不许伪装成正常退出。
        val fail = KillAudit.attribute(emptyList(), "读系统退出史失败（binder 调用没答上来）", 0L, main)
        assertTrue(fail, fail.contains("死因未取证（读系统退出史失败"))
        val tooOld = KillAudit.attribute(emptyList(), "本机系统（API 29）不提供退出史", 0L, main)
        assertTrue(tooOld, tooOld.contains("API 29"))
        // 没有任何记录时也不能给出一个凶手。
        val empty = KillAudit.attribute(emptyList(), null, 0L, main)
        assertTrue(empty, empty.startsWith("死因未取证（"))
        // 定罪的反面：这三句里一句都不许出现「锚掉」——判决掉线另有当场观测边在告警，
        // 事后拿它当死因就是把一句猜测冒充成取证。
        for (line in listOf(fail, tooOld, empty)) assertFalse(line, line.contains("锚掉"))
    }

    @Test fun 口径词表不重名_未取证与未归因是两件事() {
        val codes = Journal.Reason.values().map { it.code }
        assertEquals(codes.joinToString(), codes.size, codes.toSet().size)
        // UNKNOWN = 有记录但词表不认（数字照记）；UNREADABLE = 连记录都没拿到。
        // 把两者并成一个，采集失败就会被读成「本机没被杀过」。
        assertFalse(Journal.Reason.UNKNOWN.code == Journal.Reason.UNREADABLE.code)
        assertEquals("unreadable", Journal.Reason.UNREADABLE.code)
    }
}
