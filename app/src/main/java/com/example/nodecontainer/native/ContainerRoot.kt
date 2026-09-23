package com.example.nodecontainer.native

import android.content.Context
import java.io.File

/**
 * 容器根（用户态路径命名空间）的宿主侧准备。
 *
 * 真机实测：app 打不开自己路径上的祖先（/data/user/0、/data、/ 全 EACCES），
 * 也建不了 user namespace（unshare(CLONE_NEWUSER)=EINVAL，见 native/rootprobe）。
 * 内核级容器根不可得，故由 native/rootns 的 libdshrootns.so 在 libc 层把绝对路径
 * 解析进本根：Agent 于是拥有一棵从 / 开始、祖先链属于自己的文件系统。见 docs/ADR-001。
 */
object ContainerRoot {

    /** 命名空间内路径（Agent 视角）。 */
    const val HOME_PATH = "/home"
    const val DSH_HOME_PATH = "/home/.dsh"

    /** kill switch：存在该文件即回退真实路径，无需重编即可排障。 */
    private fun disabled(ctx: Context): Boolean = File(ctx.filesDir, ".rootns-off").exists()

    fun root(ctx: Context): File = File(ctx.filesDir, "root")
    fun home(ctx: Context): File = File(root(ctx), "home")
    fun dshHomeReal(ctx: Context): File = File(home(ctx), ".dsh")

    /**
     * 建根并把既有 ~/.dsh 迁入；返回是否启用。
     * 迁移只做一次：目标已存在则不覆盖，避免丢用户数据（配置/凭据/会话）。
     */
    fun prepare(ctx: Context): Boolean {
        if (disabled(ctx)) return false
        File(root(ctx), "tmp").mkdirs()
        File(root(ctx), "etc").mkdirs()
        home(ctx).mkdirs()
        val legacy = File(ctx.filesDir, ".dsh")
        val target = dshHomeReal(ctx)
        if (legacy.isDirectory && !target.exists()) {
            if (!legacy.renameTo(target)) legacy.copyRecursively(target, overwrite = false)
        }
        return true
    }
}
