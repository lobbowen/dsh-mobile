package io.github.lobbowen.dshmobile.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * OTA 准入判定（ADR-0005 C1/C3/C4）—— 六条规则逐条钉死。
 *
 * 为什么值得这么多用例：这是整条链路上**唯一**能挡住"不该装的包"的地方，
 * 而且每条规则写反的后果都是**静默的**：
 *   过期写反 → 永远冻结在旧版本；重放写反 → 可以回滚设备；
 *   下限写反 → 降级安装；灰度写反 → 停发失效或永远发不出去。
 */
class OtaPolicyTest {

    private fun input(
        remote: String = "0.2.0",
        current: String? = "0.1.0",
        floor: String? = null,
        expires: Long = 0L,
        seq: Long = 0L,
        lastSeq: Long = 0L,
        rollout: Int = 100,
        installId: String = "dev-1",
        now: Long = 1_000L,
    ) = OtaPolicy.Input(remote, current, floor, expires, seq, lastSeq, rollout, installId, now)

    private fun rejectCode(v: OtaPolicy.Verdict): String {
        assertTrue("期望 Reject，实际 " + v, v is OtaPolicy.Verdict.Reject)
        return (v as OtaPolicy.Verdict.Reject).code
    }

    // ① 新鲜度
    @Test fun 过期即拒() {
        assertEquals("manifest-expired", rejectCode(OtaPolicy.evaluate(input(expires = 500L, now = 1_000L))))
    }

    @Test fun 未过期则继续() {
        assertTrue(OtaPolicy.evaluate(input(expires = 5_000L, now = 1_000L)) is OtaPolicy.Verdict.Install)
    }

    @Test fun 未声明有效期时不拦() {
        assertTrue(OtaPolicy.evaluate(input(expires = 0L, now = 9_999_999L)) is OtaPolicy.Verdict.Install)
    }

    // ② 防重放
    @Test fun sequence不高于已见水位即拒() {
        assertEquals("manifest-replay", rejectCode(OtaPolicy.evaluate(input(seq = 5L, lastSeq = 5L))))
        assertEquals("manifest-replay", rejectCode(OtaPolicy.evaluate(input(seq = 3L, lastSeq = 5L))))
    }

    @Test fun sequence更大则放行() {
        assertTrue(OtaPolicy.evaluate(input(seq = 6L, lastSeq = 5L)) is OtaPolicy.Verdict.Install)
    }

    @Test fun 首次水位为零时任何正sequence都放行() {
        assertTrue(OtaPolicy.evaluate(input(seq = 1L, lastSeq = 0L)) is OtaPolicy.Verdict.Install)
    }

    // ③ 是否更新
    @Test fun 稳定态报已是最新_而不是疑似重放() {
        // 真机实测：设备装好后水位 == manifest 的 sequence，同一份 manifest 再来一次。
        // 此时必须报"已是最新"，否则日志看起来像被攻击了（归因误导）。
        val v = OtaPolicy.evaluate(input(remote = "1.0.0", current = "1.0.0", seq = 100L, lastSeq = 100L))
        assertTrue("稳定态应为 UpToDate，实际 " + v, v is OtaPolicy.Verdict.UpToDate)
    }

    @Test fun 版本确实更新但序列重放_仍必须被拦() {
        // 顺序调整**不能**削弱安全性：远端更新 + 序列不前进 = 重放，必须拒。
        assertEquals("manifest-replay",
            rejectCode(OtaPolicy.evaluate(input(remote = "0.2.0", current = "0.1.0", seq = 100L, lastSeq = 100L))))
    }

    @Test fun 相等版本判为已是最新() {
        assertTrue(OtaPolicy.evaluate(input(remote = "1.0.0", current = "1.0.0")) is OtaPolicy.Verdict.UpToDate)
    }

    @Test fun 远端更旧判为已是最新() {
        assertTrue(OtaPolicy.evaluate(input(remote = "0.1.0", current = "0.2.0")) is OtaPolicy.Verdict.UpToDate)
    }

    @Test fun 尚未安装时准予安装() {
        assertTrue(OtaPolicy.evaluate(input(current = null)) is OtaPolicy.Verdict.Install)
    }

    @Test fun 数字段按数值而非字符串_11大于2() {
        assertTrue("0.1.0-android.11 > 0.1.0-android.2 必须判为更新",
            OtaPolicy.evaluate(input(remote = "0.1.0-android.11", current = "0.1.0-android.2")) is OtaPolicy.Verdict.Install)
    }

    // ④ 版本下限
    @Test fun 低于下限即拒() {
        assertEquals("version-below-floor",
            rejectCode(OtaPolicy.evaluate(input(remote = "0.1.0-android.2", current = null, floor = "0.1.0-android.11"))))
    }

    @Test fun 等于下限允许安装() {
        assertTrue(OtaPolicy.evaluate(input(remote = "0.1.0-android.11", current = null, floor = "0.1.0-android.11")) is OtaPolicy.Verdict.Install)
    }

    @Test fun 下限检查先于灰度_安全约束不被灰度短路() {
        assertEquals("version-below-floor",
            rejectCode(OtaPolicy.evaluate(input(remote = "0.1.0-android.2", current = null, floor = "0.1.0-android.11", rollout = 0))))
    }

    // ⑤ 灰度
    @Test fun 停发时未命中的设备不安装() {
        assertTrue("rolloutPercent=0 即停发", OtaPolicy.evaluate(input(rollout = 0)) is OtaPolicy.Verdict.Holdback)
    }

    @Test fun 全量时直接准入() {
        assertTrue(OtaPolicy.evaluate(input(rollout = 100)) is OtaPolicy.Verdict.Install)
    }

    @Test fun 已安装过相同版本时不会被灰度影响() {
        // 顺序保证：先判"已是最新"，再判灰度 —— 否则已是最新的设备会收到"灰度未命中"的噪音
        assertTrue(OtaPolicy.evaluate(input(remote = "1.0.0", current = "1.0.0", rollout = 0)) is OtaPolicy.Verdict.UpToDate)
    }

    // ⑥ checkOnly
    @Test fun checkOnly返回Available且不被灰度挡住() {
        assertTrue("检查更新只关心有没有新版本",
            OtaPolicy.evaluate(input(rollout = 0), checkOnly = true) is OtaPolicy.Verdict.Available)
    }

    @Test fun checkOnly仍受安全约束() {
        assertTrue(OtaPolicy.evaluate(input(expires = 500L, now = 1_000L), checkOnly = true) is OtaPolicy.Verdict.Reject)
        assertTrue(OtaPolicy.evaluate(input(seq = 3L, lastSeq = 5L), checkOnly = true) is OtaPolicy.Verdict.Reject)
    }

    // 分桶
    @Test fun 桶号恒在0到99且确定() {
        for (id in listOf("", "dev-1", "设备-甲", "x".repeat(500), "IntMin?")) {
            val b = OtaPolicy.bucketOf(id, "1.0.0")
            assertTrue("桶号必须落在 0..99（收到 " + b + "）", b in 0..99)
            assertEquals("同一设备同一版本必须同桶（否则灰度=随机）", b, OtaPolicy.bucketOf(id, "1.0.0"))
        }
    }

    @Test fun floorMod消除了负桶号这个停发后门() {
        // String.hashCode() 可能是 Int.MIN_VALUE，而 Math.abs(Int.MIN_VALUE) 仍是负数：
        // 旧写法 Math.abs(h)%100 会得到负桶号 → rollout=0（停发）时 bucket >= 0 判为 false
        // → 停发失效、设备照样安装。概率极低，但那是安全承诺被打破。
        assertTrue("旧写法确实会变负", Math.abs(Int.MIN_VALUE) % 100 < 0)
        assertTrue("floorMod 恒非负", Math.floorMod(Int.MIN_VALUE, 100) >= 0)
    }
}
