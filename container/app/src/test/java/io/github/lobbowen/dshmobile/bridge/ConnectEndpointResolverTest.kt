package io.github.lobbowen.dshmobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * shell 参数装配（纯函数）。钉的是「端点来源」这条规则 —— 真机 2026-09-25 因吃
 * state.json 的旧连接端口（无线调试重启后已轮换）导致通道整体失联，首页却仍显示已配对。
 */
class ConnectEndpointResolverTest {

    private fun argsOf(endpoint: ConnectEndpointResolver.Endpoint, cmd: String = "id") =
        ConnectEndpointResolver.shellArgs(cmd, 20_000L, endpoint)

    @Test fun 现场端点必须透传成显式参数() {
        val a = argsOf(ConnectEndpointResolver.Endpoint("192.168.3.74", 44019))
        assertEquals("--host 后面必须紧跟现场 host", "192.168.3.74", a[a.indexOf("--host") + 1])
        assertEquals("--connect-port 后面必须紧跟现场 port", "44019", a[a.indexOf("--connect-port") + 1])
    }

    @Test fun 未知端点不塞参数留给Node侧回落() {
        val a = argsOf(ConnectEndpointResolver.Endpoint())
        assertFalse("host 未知时不能出现 --host", a.contains("--host"))
        assertFalse("port 未知时不能出现 --connect-port", a.contains("--connect-port"))
    }

    @Test fun 半截端点也不冒充() {
        val noPort = argsOf(ConnectEndpointResolver.Endpoint("192.168.3.74", 0))
        assertFalse("port<=0 不能写成 --connect-port 0", noPort.contains("--connect-port"))
        val noHost = argsOf(ConnectEndpointResolver.Endpoint("  ", 44019))
        assertFalse("空白 host 不能写成 --host", noHost.contains("--host"))
    }

    @Test fun 命令整体只占一个argv位不经shell() {
        val nasty = "echo a; rm -rf / --host 1.2.3.4"
        val a = argsOf(ConnectEndpointResolver.Endpoint(), nasty)
        assertEquals("cmd 必须是原样单元素，不能被拆", nasty, a[a.indexOf("--cmd") + 1])
        assertEquals("--cmd 之后直到 --timeout-ms 之间只应有 cmd 一项",
            "--timeout-ms", a[a.indexOf("--cmd") + 2])
    }
}
