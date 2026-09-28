package lobos.capability

/**
 * 配对成功后的静默自动流：只挑"取法链首项 = SILENT_VIA_ADB"且尚未授权的项，
 * 在配对成功的同一前台会话内办掉（不产生按钮、不挡入口）。
 *
 * 就绪判据 = 凭据已配对 且 通道读数在线（未在线时返回空 plan：不制造假绿）。
 */
object PostPairingAutoFlow {

    fun ready(e: Evidence): Boolean =
        e.credentials == CredentialsState.PAIRED && e.channelLive()

    /** 静默可办的项（id 升序，稳定输出）。已 GRANTED 的项不在其中。 */
    fun plan(e: Evidence): List<String> {
        if (!ready(e)) return emptyList()
        val verdicts = CapabilityCatalog.evaluate(e)
        return verdicts.keys.sorted().filter { id ->
            val v = verdicts[id]
            if (v?.status != CapStatus.ACTION) return@filter false
            if (e.granted(id)) return@filter false
            val acq = CapabilityCatalog.byId(id)?.acquirer(e)?.firstOrNull()
            acq != null && acq.kind == AcquireKind.SILENT_VIA_ADB
        }
    }
}
