package io.github.lobbowen.dshmobile

import android.content.Context
import android.os.Build
import io.github.lobbowen.dshmobile.capability.CapabilityCatalog
import io.github.lobbowen.dshmobile.capability.CapabilityEvidenceCollector
import io.github.lobbowen.dshmobile.capability.BridgeTokens
import io.github.lobbowen.dshmobile.capability.CapStatus
import io.github.lobbowen.dshmobile.capability.Evidence
import io.github.lobbowen.dshmobile.kernelota.KernelManager
import io.github.lobbowen.dshmobile.permissions.LifecycleChecks
import java.io.File

/**
 * 预置自检探针（docs/runbook/provisioning.md §4）—— 开机体检报告的**投影**。
 *
 * 为什么需要它：控制面能力（Device Owner / 无障碍 / ADB 通道 / MediaProjection / 特殊权限）
 * 焊死在设备 + APK 里，无法经内核包热更新获得；换机、恢复出厂、`dpm remove-active-admin`
 * 之后会**静默消失**。内核侧只看到桥握手少了几组，分不清「没预置」还是「预置坏了」，
 * 所以把这件事变成开机可见的报告，落 files/diagnostics.txt + files/provisioning.json，
 * 由 MainActivity 轮询渲染。
 *
 * 与 v1 的关键差别（spec §2.5）：这里**不写任何判据表达式**。每项能力直接取
 * [CapabilityCatalog] 的结论 —— 首页、桥门禁、体检三份报告从此同源。
 * v1 在这里手抄 `File(filesDir,"adb/state.json")`、`isDeviceOwnerApp`、Secure 设置串，
 * 与首页各判各的，真机 2026-09-25 的错位就是这么产生的。
 *
 * 复用 [RuntimeDiagnostics]（文件型跨进程），因此探针可在 :node 进程跑、UI 进程读；
 * 采集走 [CapabilityEvidenceCollector.systemReads]（不 spawn 通道探针、不打控制面 HTTP）。
 */
object ProvisioningProbe {

    /** 生命周期风险行（不属于能力登记表：它描述保活质量，不是控制面能力）。 */
    const val LIFECYCLE = "lifecycle"

    /**
     * 跑全量体检并把结果写入诊断日志。
     * @return 通过项数 / **参与放行**的项数（optional 项不计入分母，否则普通手机永远不满分）
     */
    fun run(ctx: Context): Pair<Int, Int> = run(ctx, CapabilityEvidenceCollector.systemReads(ctx))

    /** 测试缝：判据投影与 Android 取数分离，JVM 侧可用构造好的 [Evidence] 钉死报告语义。 */
    internal fun run(ctx: Context, e: Evidence): Pair<Int, Int> {
        val verdicts = CapabilityCatalog.evaluate(e)
        val results = CapabilityCatalog.ALL.map { c ->
            val v = verdicts.getValue(c.id)
            ProbeResult(
                id = c.id,
                label = c.title,
                segment = c.segment,
                optional = c.optional,
                ok = v.status == CapStatus.GRANTED,
                status = v.status.name + "：" + v.detail,
                hint = c.acquirer(e).joinToString(" → ") { it.label }
                    .ifBlank { "无需动作" },
            )
        } + checkLifecycle(ctx)

        for (r in results) {
            RuntimeDiagnostics.append(ctx, "probe:${r.id}", r.ok, "${r.label} —— ${r.status}", r.hint)
        }
        val gating = results.filterNot { it.optional }
        val passed = gating.count { it.ok }
        RuntimeDiagnostics.append(
            ctx,
            "probe",
            passed == gating.size,
            "预置体检：$passed/${gating.size} 项通过",
            if (passed == gating.size) "全部控制面能力就绪"
            else "缺失项对应的 bridge 方法组会返回 -32001（这是预期降级，不是崩溃）；" +
                "可选加速器（Device Owner / 屏幕捕获）不计入分母",
        )
        writeSnapshot(ctx, e, results)
        return passed to gating.size
    }

    /** 生命周期风险（电池优化 / phantom process killer / 前台保活前提）。 */
    private fun checkLifecycle(ctx: Context): ProbeResult {
        val lines = LifecycleChecks.collect(ctx)
        val ok = lines.count { it.ok }
        return ProbeResult(
            id = LIFECYCLE,
            label = "生命周期风险",
            segment = "",
            optional = false,
            ok = ok == lines.size,
            status = "$ok/${lines.size} 项就绪",
            hint = lines.joinToString("\n") { it.title + "=" + it.detail },
        )
    }

    // ---- 机器可读快照 ----

    private fun writeSnapshot(ctx: Context, e: Evidence, results: List<ProbeResult>) {
        try {
            val km = KernelManager(ctx)
            val obj = org.json.JSONObject().apply {
                // schema 2：checks 的 id 从「六项手写探针」换成能力登记表 id（同名者仅 device-owner /
                // accessibility / mediaprojection），并新增 segment/optional 与 capabilities 字段。
                put("schema", 2)
                // 两条版本流各自的身份 + 协议版本：排查「为什么某功能没生效」先看这三个值（ADR-0004 §5）。
                put("appVersion", BuildConfig.VERSION_NAME)
                put("appVersionCode", BuildConfig.VERSION_CODE)
                put("bridgeProtocol", BuildConfig.BRIDGE_PROTOCOL)
                put("kernelVersion", km.currentVersion() ?: "")
                // C1/C2 可观测：版本下限（只增不减）与「已安装但尚未提交」的版本。
                put("kernelFloor", km.floorVersion() ?: "")
                put("kernelPending", km.pending()?.version ?: "")
                put("checkedAt", System.currentTimeMillis())
                put("androidApi", Build.VERSION.SDK_INT)
                put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
                put("capabilities", org.json.JSONArray(BridgeTokens.from(e).toList()))
                put("checks", org.json.JSONArray().apply {
                    for (r in results) {
                        put(org.json.JSONObject().apply {
                            put("id", r.id)
                            put("label", r.label)
                            put("segment", r.segment)
                            put("optional", r.optional)
                            put("ok", r.ok)
                            put("status", r.status)
                            put("hint", r.hint)
                        })
                    }
                })
            }
            File(ctx.filesDir, "provisioning.json").writeText(obj.toString(2))
        } catch (_: Throwable) {
            // 探针失败绝不影响启动流程
        }
    }

    data class ProbeResult(
        val id: String,
        val label: String,
        val segment: String,
        val optional: Boolean,
        val ok: Boolean,
        val status: String,
        val hint: String,
    )
}
