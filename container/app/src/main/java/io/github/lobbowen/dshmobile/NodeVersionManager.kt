package io.github.lobbowen.dshmobile

import android.content.Context
import org.json.JSONObject

/**
 * 内置 Node 版本的元信息读取。
 *
 * 运行时来源唯一：APK 内 jniLibs 解压出的 libnode.so。仅用于启动诊断显示版本。
 */
class NodeVersionManager(private val context: Context) {

    /** 清单里的一条版本记录。bundled 恒为 true —— 见类注释。 */
    data class NodeVersion(
        val version: String,
        val channel: String,
        val minAndroidApi: Int
    )

    data class Manifest(val default: String, val abi: String, val versions: List<NodeVersion>)

    /**
     * 读取 assets/node-versions.json。
     *
     * 失败时抛异常（由调用方展示到诊断面板）—— 不要在这里静默兜底成某个
     * 默认版本号，那会掩盖"清单被改坏了"这个事实，反而更难排查。
     */
    fun loadManifest(): Manifest {
        val text = context.assets.open("node-versions.json")
            .bufferedReader().use { it.readText() }
        val json = JSONObject(text)
        val versions = json.getJSONArray("versions").let { arr ->
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                NodeVersion(
                    version = o.getString("version"),
                    channel = o.optString("channel", "unknown"),
                    minAndroidApi = o.optInt("minAndroidApi", 24)
                )
            }
        }
        return Manifest(
            default = json.getString("default"),
            abi = json.getString("abi"),
            versions = versions
        )
    }

    /**
     * 当前生效的 Node 版本号。
     *
     * 语义很直接：就是清单里的 default。不存在"运行期切换版本"这回事，
     * 因为可执行的运行时只能来自 APK 的 nativeLibraryDir（见类注释）。
     *
     * 注意这个值【仅用于展示】。真正跑的二进制版本以实际 `node -v` 输出为准，
     * 两者理论上应该一致（构建时会同步清单，见 build-node.yml 的 sync 步骤），
     * 但诊断面板上以 `node -v` 的实测输出为最终依据。
     */
    fun currentVersion(): String = loadManifest().default
}
