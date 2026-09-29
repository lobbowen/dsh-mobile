package lobos.os

import lobos.runtime.PrefixProvisioner
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 环境自洽判据 golden —— 它是 `RuntimeEnvironment.ensure` 唯一的**进缓存**闸门。
 *
 * 钉的是「什么算装配完成」：$PREFIX 缺件、或 npm 没有 `$PREFIX/bin` 真名（债表 ENV-3），
 * 都必须是「未完成」，否则一次失败会被进程缓存成常驻态 —— 之后每次调用都拿到同一份坏快照，
 * 而屏幕上写着「已装配」。这两件事在真机上都是静默的：guest 侧只会得到 `command not found`。
 */
class RuntimeEnvironmentTest {

    private fun snapshot(
        missing: List<String> = emptyList(),
        npmBin: File? = File("/prefix/bin/npm"),
    ) = RuntimeEnvironment.Snapshot(
        nodeBin = File("/native/libnode.so"),
        prefixReady = PrefixProvisioner.expected - missing,
        prefixMissing = missing,
        npmEntry = File("/cache/npm/bin/npm-cli.js"),
        npmBin = npmBin,
        envShim = File("/cache/node/android-env-shim.cjs"),
        npmrc = File("/home/.npmrc"),
    )

    @Test fun 齐件且npm有真名才算完整() {
        assertTrue(snapshot().complete)
    }

    @Test fun 缺任何一个能力件就不完整() {
        assertFalse(snapshot(missing = listOf("rg")).complete)
        assertFalse(snapshot(missing = listOf(PrefixProvisioner.NODE_BIN_NAME)).complete)
    }

    @Test fun npm没有PREFIX真名就不完整() {
        // npmEntry 有值只说明解包成功；按名字调用靠的是那个链接，不能拿前者冒充后者。
        assertFalse(snapshot(npmBin = null).complete)
    }
}
