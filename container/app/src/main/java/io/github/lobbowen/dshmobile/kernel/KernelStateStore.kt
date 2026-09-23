package io.github.lobbowen.dshmobile.kernel

import java.io.File

/**
 * 内核指针 / 版本下限 / 待命标记的**纯文件状态机**（不依赖 Android）。
 *
 * 三个文件都放在内核根目录下：
 *   · CURRENT —— 当前生效版本
 *   · FLOOR   —— **曾成功提交过的最高版本**（只增不减，反回滚的核心）
 *   · PENDING —— 已安装但**尚未提交**的版本 + 来源版本（首行 version，次行 from）
 *
 * 为什么把 PENDING 与 CURRENT 分开：安装成功 ≠ 这个内核能跑。
 * 真正的"提交"时机是**首次健康检查通过**；在那之前它只是 pending，起不来就回滚，
 * 且回滚**不动 FLOOR** —— 否则"回滚"就成了降级的后门。
 */
class KernelStateStore(private val root: File) {

    data class Pending(val version: String, val from: String?)

    private val currentPointer: File get() = File(root, "CURRENT")
    private val floorFile: File get() = File(root, "FLOOR")
    private val pendingFile: File get() = File(root, "PENDING")

    fun currentVersion(): String? =
        if (currentPointer.exists()) currentPointer.readText().trim().ifBlank { null } else null

    /** 原子写：先写临时再 rename（断电只会得到"改名成功"或"没改名"）。 */
    fun setCurrentVersion(version: String) {
        root.mkdirs()
        val tmp = File(root, "CURRENT.tmp")
        tmp.writeText(version)
        tmp.renameTo(currentPointer)
    }

    fun floorVersion(): String? = try {
        floorFile.readText().trim().ifBlank { null }
    } catch (_: Throwable) { null }

    /** 提升下限。**只增不减**：不高于现有下限的调用被忽略。 */
    fun setFloor(version: String) {
        val cur = floorVersion()
        if (cur != null && KernelVersions.compare(version, cur) <= 0) return
        root.mkdirs()
        val tmp = File(root, "FLOOR.tmp")
        tmp.writeText(version)
        tmp.renameTo(floorFile)
    }

    /** 候选是否低于下限 → 拒绝安装（即使签名合法）。 */
    fun isBelowFloor(version: String): Boolean = KernelVersions.isBelowFloor(version, floorVersion())

    fun markPending(version: String, from: String?) {
        root.mkdirs()
        pendingFile.writeText(version + "\n" + (from ?: ""))
    }

    fun pending(): Pending? = try {
        val lines = pendingFile.readText().split("\n")
        val v = lines.getOrNull(0)?.trim().orEmpty()
        if (v.isBlank()) null else Pending(v, lines.getOrNull(1)?.trim()?.ifBlank { null })
    } catch (_: Throwable) { null }

    fun clearPending() { try { pendingFile.delete() } catch (_: Throwable) { } }

    /** 回滚：把 CURRENT 指回 [from]（目录仍在时）。**FLOOR 不动**。 */
    fun rollbackTo(from: String): Boolean {
        if (!File(root, from).isDirectory) return false
        setCurrentVersion(from)
        return true
    }
}
