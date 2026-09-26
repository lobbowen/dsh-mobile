package io.github.lobbowen.dshmobile.kernelota

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 安装暂存目录的**建名 ↔ 认名**对账（K2 定罪的另一半：尸体长期无人认领）。
 *
 * 会红的改动：只改安装器的暂存命名、忘了改清扫器（或反之）—— 那时清扫永远扫不到东西，
 * 而判据照样"绿"，正是本次要钉死的失效形态。
 * 指针文件与正式版本目录必须认成 false：误认一次 = 把已装内核整目录删掉。
 */
class KernelStagingNamingTest {

    @Test fun 建名与认名往返一致() {
        val name = KernelManager.stagingDirName("0.1.0-android.13", pid = 12345, atMs = 1_690_000_000_000L)
        assertEquals("0.1.0-android.13.tmp-12345-1690000000000", name)
        assertTrue("自己建的名字自己都不认: " + name, KernelManager.isStagingDir(name))
    }

    @Test fun 真机留下的尸体认得出() {
        // 2026-09-26 真机 files/kernel/ 实测残留（长期驻留、界面零痕迹）
        assertTrue(KernelManager.isStagingDir("0.1.0-android.12.tmp-28341-1761480000123"))
    }

    @Test fun 引擎侧同形状命名也认得() {
        // container/engine/src/ota-engine.js 的 apply() 写的是 dest + ".tmp-" + pid + "-" + Date.now()，
        // 与本类是**同一落盘布局的两个写入方**；这里钉住"跨语言同形状"，否则一侧改名另一具尸体。
        assertTrue(KernelManager.isStagingDir("0.2.0.tmp-99-1761480000123"))
    }

    @Test fun 指针文件与正式版本目录绝不认成暂存() {
        for (n in listOf("CURRENT", "FLOOR", "PENDING", "state.json", "0.1.0-android.12", "kernel", "")) {
            assertFalse("误认就会误删: [" + n + "]", KernelManager.isStagingDir(n))
        }
    }

    @Test fun 形状不符的近似名不认() {
        for (n in listOf("x.tmp-", "x.tmp-1", "x.tmp-a-2", "x.tmp-1-", "xtmp-1-2", "x.tmp-1-2-3")) {
            assertFalse("不该被清扫器认领: [" + n + "]", KernelManager.isStagingDir(n))
        }
    }

    @Test fun 半包判据只认那一个后缀常量() {
        assertTrue(ResumableDownloader.isPartialFile("kernel-ota-0.1.0-android.13.zip.part"))
        assertFalse(ResumableDownloader.isPartialFile("kernel-ota-0.1.0-android.13.zip"))
        // 名字必须由常量派生：KernelOtaUpdater 拼法与自检认法共用它，字面量不许有第二处。
        assertTrue(ResumableDownloader.isPartialFile("kernel-ota-x.zip" + ResumableDownloader.PART_SUFFIX))
    }
}
