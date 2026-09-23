package io.github.lobbowen.dshmobile.kernel.adb

/**
 * ADB 握手状态机 —— 纯逻辑，不发包、不碰 socket，因此完全可单测。
 *
 * 为什么值得单独成层：
 *   认证是**唯一**决定"我们到底有没有 shell 权限"的地方，而它的迁移很反直觉：
 *     · 首次连接服务端发 `AUTH(token)`；客户端用**私钥签名**回 `AUTH(signature)`。
 *     · 若服务端不认识我们的公钥，它会**再发一次** `AUTH(token)` ——
 *       此时正确响应是回 **公钥**（`AUTH(RSAPUBLICKEY)`），而不是再签一次。
 *     · 公钥也被拒（用户没点确认 / 配对已失效）→ 只能失败，不能无限重试。
 *
 *   把这些迁移写成状态机并逐条钉住，可以避免"失败后无限重发签名"这类
 *   会把连接拖死、且在现场极难定位的问题。
 */
object AdbHandshake {

    enum class Phase { START, SIGNATURE_SENT, PUBKEY_SENT, READY, FAILED }

    sealed class Action {
        data class SendSignature(val token: ByteArray) : Action()
        data class SendPublicKey(val token: ByteArray) : Action()
        object Ready : Action()
        data class Fail(val reason: String) : Action()
    }

    data class Step(val phase: Phase, val action: Action)

    /**
     * 处理一条来自服务端的消息。
     *
     * @param command 已解析的命令
     * @param arg0    AUTH 时为子类型（token / signature / pubkey）
     * @param payload 令牌内容（token 场景下要拿它去签名）
     */
    fun onMessage(phase: Phase, command: AdbProtocol.Command, arg0: Int, payload: ByteArray): Step {
        // 终态：任何后续消息都不该被处理（避免"失败后还在重试"）。
        if (phase == Phase.READY) return Step(Phase.READY, Action.Fail("握手已完成，收到多余消息: " + command.wire))
        if (phase == Phase.FAILED) return Step(Phase.FAILED, Action.Fail("握手已失败，不再处理: " + command.wire))

        if (command == AdbProtocol.Command.CNXN) {
            return Step(Phase.READY, Action.Ready)
        }
        if (command != AdbProtocol.Command.AUTH) {
            return Step(Phase.FAILED, Action.Fail("握手期收到意外命令: " + command.wire))
        }

        // 服务端只会在需要认证时发 AUTH(token)。收到 signature/pubkey 子类型说明双方理解不一致。
        if (arg0 != AdbProtocol.AUTH_TOKEN) {
            return Step(Phase.FAILED, Action.Fail("握手期收到非 token 的 AUTH 子类型: " + arg0))
        }

        return when (phase) {
            Phase.START -> Step(Phase.SIGNATURE_SENT, Action.SendSignature(payload))
            // 服务端不认识我们的公钥 → 它再发一次 token；此时应回**公钥**，不是再签一次。
            Phase.SIGNATURE_SENT -> Step(Phase.PUBKEY_SENT, Action.SendPublicKey(payload))
            // 公钥也被拒（用户没确认 / 配对失效）→ 失败，不在本地无限重试。
            Phase.PUBKEY_SENT -> Step(Phase.FAILED, Action.Fail("公钥也被拒绝：请确认已在设备上允许本机的调试授权"))
            else -> Step(Phase.FAILED, Action.Fail("非法状态: " + phase))
        }
    }
}
