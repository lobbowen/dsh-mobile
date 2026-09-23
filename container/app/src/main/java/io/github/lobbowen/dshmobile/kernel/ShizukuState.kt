package io.github.lobbowen.dshmobile.kernel

/**
 * Shizuku 可用性的**四态分类** —— 纯逻辑，不依赖 Android。
 *
 * 为什么值得单独抽出来：Shizuku 是 `shell.exec` 的**必备能力本体**（ADR-0003，不做可选/降级），
 * 而它的可用性有四种互不相同的处置方式：
 *
 *   未安装            → 去装（并说明它为什么是必需的）
 *   装了但守护进程没起 → 打开 Shizuku 点一次「启动」（非 root 机型每次重启都要）
 *   起了但未授权本应用 → 去「已授权应用」里添加
 *   就绪              → 可用
 *
 * 旧实现把这四种状态的判断与提示文案写在一个 Android 方法里，只能靠真机试。
 * 抽出来之后，"装了没启动" 与 "没装" 不会被混为一谈，而 `ok` 必须**同时**依赖
 * 「守护进程在跑」与「已授权」—— 少判任一条都等于静默地误报能力可用/不可用。
 */
object ShizukuState {

    enum class State { READY, NO_PERMISSION, NOT_RUNNING, NOT_INSTALLED }

    data class Classified(val state: State, val ok: Boolean, val status: String, val hint: String)

    /** Shizuku 的包名（未安装时提示里要给出）。 */
    const val PACKAGE = "moe.shizuku.privileged.api"

    /**
     * @param installedVersion 已安装的版本名；null = 未安装
     * @param binderAlive      守护进程（binder）是否在跑
     * @param granted          本应用是否已被授权
     */
    fun classify(installedVersion: String?, binderAlive: Boolean, granted: Boolean): Classified {
        // 顺序即优先级：先看"能不能真的用"（binder + 授权），再看安装与否。
        // 特别注意：只有 binderAlive 而没有 granted 时**不可用** —— 这一点很容易写错。
        if (binderAlive && granted) {
            return Classified(
                State.READY, true,
                "已授权且守护进程在跑",
                "shell.exec 以 shell uid(2000) 执行（privileged=true）。",
            )
        }
        if (binderAlive) {
            return Classified(
                State.NO_PERMISSION, false,
                "守护进程在跑，但本应用尚未授权",
                "打开 Shizuku → 已授权应用 → 添加本应用；授权后 shell.exec 立即可用。",
            )
        }
        if (installedVersion != null) {
            return Classified(
                State.NOT_RUNNING, false,
                "已安装 v" + installedVersion + " 但守护进程未启动",
                "Shizuku 已安装但守护进程没起来：打开 Shizuku 点一次「启动」" +
                    "（非 root 机型每次重启都需启动；Android 11+ 可用无线调试在本机完成）。",
            )
        }
        return Classified(
            State.NOT_INSTALLED, false,
            "未安装",
            "shell.exec 依赖 Shizuku（必备能力，ADR-0003）。请安装 Shizuku（" + PACKAGE + "）" +
                "并以 adb / 无线调试启动，然后授权本应用。\n" +
                "未满足前 shell 能力组不可用，调用返回 -32001。",
        )
    }
}
