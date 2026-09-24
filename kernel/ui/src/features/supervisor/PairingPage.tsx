/**
 * ADB 无线调试配对页
 * ============================================================================
 * 手输「设备地址 + 连接端口 + 配对端口 + 6 位配对码」完成自助配对（通用，任意设备）。
 * 配对成功后可直接跑 `id` 自检（应为 uid=2000），或清除已保存端点。
 * 说明：连接端口在设备「无线调试」页；配对端口与配对码在「使用配对码配对设备」弹窗
 *      （弹窗关闭即撤销端口），因此配对时需保持弹窗打开。
 * ============================================================================
 */
import { useEffect, useState } from "react";
import { PlugZap, Smartphone, Terminal, Trash2 } from "lucide-react";
import { Button, Input, Label, Spinner } from "../../framework/ui";
import { supervisorApi, type AdbStatus } from "../../services/supervisor";

type Msg = { kind: "ok" | "err"; text: string } | null;

export function PairingPage() {
  const [host, setHost] = useState("");
  const [pairPort, setPairPort] = useState("");
  const [connectPort, setConnectPort] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<AdbStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [idOut, setIdOut] = useState("");

  const refresh = async () => {
    try { setStatus(await supervisorApi.adbStatus()); } catch { /* 读取失败保持旧值 */ }
  };

  useEffect(() => {
    void supervisorApi.adbStatus().then(setStatus).catch(() => undefined);
  }, []);

  const onPair = async () => {
    setMsg(null); setIdOut("");
    const pp = Number(pairPort);
    const cp = connectPort.trim() ? Number(connectPort) : undefined;
    if (!host.trim() || !(pp > 0) || !code.trim()) {
      setMsg({ kind: "err", text: "请填写设备地址、配对端口与配对码" });
      return;
    }
    setBusy("pair");
    try {
      const r = await supervisorApi.adbPair({ host: host.trim(), pairPort: pp, code: code.trim(), connectPort: cp });
      setMsg({ kind: "ok", text: "配对成功 · 设备 GUID：" + r.guid });
      setCode("");
      await refresh();
    } catch (e) {
      setMsg({ kind: "err", text: "配对失败：" + (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const onSelfCheck = async () => {
    setMsg(null); setIdOut(""); setBusy("shell");
    try {
      const r = await supervisorApi.adbShell({ cmd: "id" });
      setIdOut(r.out);
    } catch (e) {
      setMsg({ kind: "err", text: "执行失败：" + (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const onForget = async () => {
    setMsg(null); setIdOut(""); setBusy("forget");
    try {
      await supervisorApi.adbForget();
      await refresh();
      setMsg({ kind: "ok", text: "已清除保存的连接端点" });
    } catch (e) {
      setMsg({ kind: "err", text: "清除失败：" + (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-card p-4">
        <header className="mb-3 flex items-center gap-2">
          <Smartphone className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">设备状态</h2>
        </header>
        {status ? (
          <dl className="grid gap-1 text-xs leading-relaxed text-muted-foreground">
            <div>配对状态：<span className={status.paired ? "text-status-ok" : ""}>{status.paired ? "已配对" : "未配对"}</span></div>
            {status.paired ? <div>地址：{status.host}:{status.connectPort} · GUID {status.guid}</div> : null}
            <div className="break-all">ADB 公钥：{status.pubkey ?? "（尚未生成）"}</div>
          </dl>
        ) : (
          <div className="text-xs text-muted-foreground">读取中…</div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void refresh()}>
            <PlugZap className="size-4" />刷新
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null || !status?.paired} onClick={() => void onSelfCheck()}>
            {busy === "shell" ? <Spinner className="size-4" /> : <Terminal className="size-4" />}id 自检
          </Button>
          <Button size="sm" variant="destructive" disabled={busy !== null || !status?.paired} onClick={() => void onForget()}>
            <Trash2 className="size-4" />忘记端点
          </Button>
        </div>
        {idOut ? (
          <pre className="mt-3 overflow-auto rounded-md bg-muted p-2 text-xs leading-relaxed">{idOut}</pre>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold">配对新设备</h2>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          设备上打开：设置 → 系统与更新 → 开发者选项 → 无线调试。连接端口见「无线调试」页；
          配对端口与 6 位配对码见「使用配对码配对设备」弹窗（配对期间请保持弹窗打开）。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="adb-host">设备地址</Label>
            <Input id="adb-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.3.74" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="adb-connect">连接端口</Label>
            <Input id="adb-connect" inputMode="numeric" value={connectPort} onChange={(e) => setConnectPort(e.target.value)} placeholder="40595" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="adb-pair">配对端口</Label>
            <Input id="adb-pair" inputMode="numeric" value={pairPort} onChange={(e) => setPairPort(e.target.value)} placeholder="42111" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="adb-code">配对码（6 位）</Label>
            <Input id="adb-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={busy !== null} onClick={() => void onPair()}>
            {busy === "pair" ? <Spinner className="size-4" /> : null}开始配对
          </Button>
          {msg ? (
            <span className={"text-xs " + (msg.kind === "ok" ? "text-status-ok" : "text-destructive")}>{msg.text}</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
