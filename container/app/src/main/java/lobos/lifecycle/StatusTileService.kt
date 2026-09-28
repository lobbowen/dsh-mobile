package lobos.lifecycle

import android.graphics.drawable.Icon
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import lobos.R
import lobos.os.OsInit

/**
 * 快速设置磁贴（A14 可见性载体）：状态出口 + 唤起宿主。
 *
 * 边界：**不新增前台服务、不新增常驻通知** —— 唯一 FGS 仍是 OsHostService，唯一通知是它的状态出口。
 * 本组件只是把同一份状态（lobos.os.OsInit 的 state.json）显示在系统面板上，并在点击时幂等拉起宿主。
 */
class StatusTileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        refresh()
    }

    override fun onClick() {
        super.onClick()
        OsHostService.ensureRunning(this)
        refresh()
    }

    private fun refresh() {
        val tile = qsTile ?: return
        tile.state = Tile.STATE_ACTIVE
        tile.label = "Lob OS"
        tile.icon = Icon.createWithResource(this, R.drawable.ic_lobos_logo)
        tile.subtitle = OsInit.statusLine(this)
        tile.updateTile()
    }
}
