package lobos.os

import lobos.runtime.PrefixProvisioner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 环境自洽判据 golden —— 它是 `RuntimeEnvironment.ensure` 唯一的**进缓存**闸门。
 *
 * 钉的是「什么算随包能力件装配完成」：`$PREFIX` 缺任何一件都必须判「未完成」，否则一次失败
 * 会被进程缓存成常驻态 —— 之后每次调用都拿到同一份坏快照，而屏幕上写着「已装配」，
 * guest 侧只会得到 `command not found`（真机上这两件事都是静默的）。
 *
 * npm 不在这格：它与 git/curl 同级由 C 层签名清单投放，完整性走 `SupplyProvisioner` 的
 * 「声明数 vs 可用数」对账。把两条供给链的读数混进同一个布尔，缺件时就分不出断的是哪一条。
 */
class RuntimeEnvironmentTest {

    private fun snapshot(missing: List<String> = emptyList()) = RuntimeEnvironment.Snapshot(
        nodeBin = File("/native/libnode.so"),
        prefixReady = PrefixProvisioner.expected - missing.toSet(),
        prefixMissing = missing,
        envShim = File("/cache/node/android-env-shim.cjs"),
        npmrc = File("/home/.npmrc"),
    )

    @Test fun 齐件才算完整() {
        assertTrue(snapshot().complete)
    }

    /** 逐件点名：expected 里每一颗都必须能把 complete 压成 false ——
     *  只测 "rg" 一件的话，「判据只看列表长度」「某件永远被视为在位」两种坏实现都能蒙过。 */
    @Test fun 缺任意一件能力件都不完整逐件验证() {
        assertTrue("expected 为空会让本判据空转", PrefixProvisioner.expected.isNotEmpty())
        for (name in PrefixProvisioner.expected) {
            assertFalse("缺 $name 仍判完整", snapshot(missing = listOf(name)).complete)
        }
    }

    @Test fun 快照字段与缺件表同源() {
        val missing = listOf("rg", PrefixProvisioner.NODE_BIN_NAME)
        val s = snapshot(missing = missing)
        assertEquals("ready = expected 减去 missing",
            PrefixProvisioner.expected - missing.toSet(), s.prefixReady)
        assertEquals(missing, s.prefixMissing)
        assertFalse(s.complete)
    }
}
