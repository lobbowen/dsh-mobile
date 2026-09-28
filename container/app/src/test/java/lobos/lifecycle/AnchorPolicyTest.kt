package lobos.lifecycle

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * 锚判决 golden（C1 三处同源的**锚侧**，真机 2026-09-28 定罪）。
 *
 * 钉的是 `AnchorPolicy.verdict` 这一处取反的住址。它以前是 `verdictDegraded(anchorBound: Boolean)`，
 * 而调用方把 `outcome.state != AnchorState.BOUND` 传了进来 —— 两次取反互相抵消，锚掉线反而落进
 * 「保护生效：锚在位」那一条，journal 里因此出现相邻两条自我矛盾的记录。
 * 判据不收布尔不是风格问题：布尔已经被反过一次，这一层再反就没人看得出反了几次。
 */
class AnchorPolicyTest {

    @Test fun 锚掉线绝不判成保护生效() {
        assertEquals(AnchorVerdict.PROTECTED, AnchorPolicy.verdict(AnchorState.BOUND))
        assertEquals(AnchorVerdict.DEGRADED, AnchorPolicy.verdict(AnchorState.UNBOUND))
        // 「保护生效」这句话在仓内只有 BOUND 一个来源；UNBOUND 拿到它就是当初那个双重取反。
        assertNotEquals(AnchorVerdict.PROTECTED, AnchorPolicy.verdict(AnchorState.UNBOUND))
        // 取不到读数同样不许算保护生效 —— 它是采集失败，不是掉线，也不是在位。
        assertNotEquals(AnchorVerdict.PROTECTED, AnchorPolicy.verdict(AnchorState.UNKNOWN))
        assertNotEquals(AnchorVerdict.DEGRADED, AnchorPolicy.verdict(AnchorState.UNKNOWN))
    }

    @Test fun 三档判决各自都有读数来源_没有空转档位() {
        // 双向对照：每个锚读数都落到一档，且三档都被某条读数落到。
        // 有档位没人能判出来 = 零生产者（债表 D10/D11 定罪的形状），下一批改动就能悄悄复现。
        val got = AnchorState.values().map { AnchorPolicy.verdict(it) }.toSet()
        assertEquals(AnchorState.values().size, 3)
        assertEquals(AnchorVerdict.values().toSet(), got)
        assertEquals(3, AnchorVerdict.values().size)
    }
}
