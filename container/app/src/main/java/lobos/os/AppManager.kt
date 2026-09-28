package lobos.os

import android.content.Context
import java.io.File
import lobos.ota.ProgramManager

/**
 * AppManager：Program 的下载/校验/落位/卸载（架构 v4 §9；SYSTEM-API §2.3）。
 *
 * 信任根必须在 OS 原生；console 只是编排者、可停可换（A12/D5）。
 * 本文件给出接口 + 最小实现：写动作先只落 Journal 并返回 false（不伪造成功），
 * 真正落位由 ProgramInstaller / ProgramOtaUpdater 承担（后续接线）。
 */
interface AppManager {
    fun installed(ctx: Context): List<String>
    fun current(ctx: Context): String?
    fun install(ctx: Context, artifact: File): Boolean
    fun uninstall(ctx: Context, id: String): Boolean
}

/** 最小实现：只读接 ProgramManager；写动作显式 TODO。 */
object NativeAppManager : AppManager {

    override fun installed(ctx: Context): List<String> =
        runCatching { ProgramManager(ctx).installedVersions() }.getOrDefault(emptyList())

    override fun current(ctx: Context): String? =
        runCatching { ProgramManager(ctx).currentVersion() }.getOrNull()

    override fun install(ctx: Context, artifact: File): Boolean {
        // TODO: 接 ProgramInstaller（下载 -> 校验 -> 落位 -> 注册 AppRegistry）。
        Journal.append(ctx, "appmgr", null, "install 待接线 " + artifact.absolutePath)
        return false
    }

    override fun uninstall(ctx: Context, id: String): Boolean {
        // TODO: 接 ProgramInstaller 卸载并同步 AppRegistry。
        Journal.append(ctx, "appmgr", null, "uninstall 待接线 " + id)
        return false
    }
}
