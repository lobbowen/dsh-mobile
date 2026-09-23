/**
 * 设置 — 访问区块（独立自治：只依赖 lan-panel / access-key 两个端点，
 * 与版本环境、镜像源彻底解耦——各自加载、各自失败，互不拖累。）
 *
 * ⚠ 已删除的「启动」区块（勿回潮）：开机自启（/autostart）与关闭窗口行为
 *   （/settings/close-action，隐藏至托盘）—— 均属 PC 桌面壳能力，Android 内核
 *   常驻与否由 APK 容器 / Android Service 决定（docs/ANDROID-PLAN.md §5）。
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Switch } from "../../../framework/ui";
import { Input } from "../../../framework/ui/input";
import {
  supervisorApi, type AccessKeyStatus, type LanPanelStatus,
} from "../../../services/supervisor";
import { useSupervisorAction } from "../useSupervisorAction";
import { Card, CardTitle } from "../widgets";

/** 访问区块（自身只拉自身数据；任一失败只影响本区块内容，不影响其他设置卡） */
export function AccessCard() {
  const [lan, setLan] = useState<LanPanelStatus | null>(null);
  const [ak, setAk] = useState<AccessKeyStatus | null>(null);
  const [akInput, setAkInput] = useState("");
  const { busy, run } = useSupervisorAction();

  // 区块自加载：各端点独立失败（各自 catch），互不影响
  const load = useCallback(async () => {
    const [l, k] = await Promise.all([
      supervisorApi.lanPanel().catch(() => null),
      supervisorApi.accessKey().catch(() => null),
    ]);
    if (l) setLan(l);
    if (k) setAk(k);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggleLan(v: boolean) {
    setLan((p) => (p ? { ...p, enabled: v } : p));
    try {
      const r = await supervisorApi.setLanPanel(v);
      if (r.ok === false) { toast.error(r.error || "设置失败"); setLan((p) => (p ? { ...p, enabled: !v } : p)); return; }
      setLan(r); // 后端返回含真实 urls
      toast.success(v ? "已开启局域网访问" : "已关闭局域网访问（仅本机）");
    } catch (e) { toast.error(String(e)); setLan((p) => (p ? { ...p, enabled: !v } : p)); }
  }
  async function saveAccessKey() {
    const key = akInput.trim();
    if (key && key.length < 8) { toast.error("访问密钥至少 8 位（建议 16+ 位随机串）"); return; }
    await run("akk", () => supervisorApi.setAccessKey(key), {
      success: key ? "访问密钥已设置" : "访问密钥已清除",
      refresh: false,
      onDone: () => { setAkInput(""); void load(); },
    });
  }

  return (
    <Card>
      <CardTitle title="访问" subtitle="局域网访问与访问密钥" />
      <div className="grid gap-4 px-5 py-4">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <strong className="block text-sm font-medium text-foreground">面板局域网访问</strong>
            {lan ? (
              lan.enabled ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  开启后，局域网内设备可通过&nbsp;
                  {(lan.urls ?? []).map((u, i) => (
                    <span key={u}>
                      {i > 0 ? "、 " : null}
                      <code className="rounded bg-muted px-1 py-px font-mono text-foreground">{u}</code>
                    </span>
                  ))}
                  &nbsp;访问本面板。
                </p>
              ) : (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">关闭后仅本机可访问，局域网设备不可用。</p>
              )
            ) : null}
          </div>
          {lan !== null ? <span title="局域网访问"><Switch checked={lan.enabled} onCheckedChange={(v) => void toggleLan(v)} /></span> : <span className="text-xs text-muted-foreground">…</span>}
        </div>

        <div className="flex items-start justify-between gap-6 border-t border-border/60 pt-4">
          <div className="min-w-0">
            <strong className="block text-sm font-medium text-foreground">访问密钥</strong>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              局域网访问本面板需携带此密钥；本机访问不受影响。留空保存可清除。
              {ak?.configured ? <span className="mt-1 block text-status-ok">当前：已设置</span> : <span className="mt-1 block text-muted-foreground">当前：未设置</span>}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Input
            type="password" autoComplete="new-password" placeholder="输入 ≥8 位访问密钥（建议随机长串）"
            value={akInput} onChange={(e) => setAkInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void saveAccessKey(); }}
            className="flex-1"
          />
          <Button variant="outline" onClick={() => setAkInput("")} disabled={!akInput && !ak?.configured}>清除</Button>
          <Button disabled={busy === "akk"} onClick={() => void saveAccessKey()}>
            {ak?.configured ? "更新密钥" : "设置密钥"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
