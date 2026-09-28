package lobos.lifecycle

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import lobos.RuntimeDiagnostics
import lobos.os.DozeBackstop

/**
 * Doze 兜底的投递口（复检 AUD-G22）：只做"确保宿主在"这一件幂等事，做完再排下一次。
 * **不做**复活判定，也不读死亡原因 —— 那归 ResidencyAudit（定罪）与常驻链接管。
 */
class DozeBackstopReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context?, intent: Intent?) {
        if (context == null || intent?.action != DozeBackstop.ACTION) return
        RuntimeDiagnostics.append(context, "doze", null, "兜底投递：确保 OS 宿主在")
        OsHostService.ensureRunning(context)
        DozeBackstop.schedule(context)
    }
}
