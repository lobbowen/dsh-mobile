/**
 * 设置 — 关于卡（产品信息，放设置页最底部）
 *
 * Android 面板的产品构成（2026-09 去耦）：
 *   · 面板（本 Program，运行于冻结 APK 容器 Node 运行时）
 *   · 容器（APK：Node 运行时 + HostBridge + OTA，冻结不随面板升级）
 * 面板版本线独立呈现；**面板自身只提供版本读取**，安装/升级由容器 OTA 执行
 * （单写入者契约：/self-update/apply|restart-guard 已下架 = 410）。
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "../../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../framework/ui/dialog";
import { consoleApi } from "../../../services/console";
import { hasHostBridge, requestPanelUpdate } from "../../../services/console/panelUpdateBridge";
import { useConsoleAction } from "../useConsoleAction";
import { Card, CardTitle, Pill } from "../widgets";
import { cn } from "../../../framework/utils";

type VerInfo = {
  version?: string;
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
  ok?: boolean;
  error?: string | null;
  // 源码形态（git-repo）字段：经 /guard/version 与 /guard/version/check 携带
  upstream?: string;
  commit?: string;
};

const PRODUCT_NAME = "Agent Program 面板";
const PRODUCT_DESC =
  "运行于安卓容器内的系统级面板：负责启动、存活监测与故障自动重启被监管目标，" +
  "提供生命周期管理、智能路由与插件/分发运维面板。面板由容器 OTA 升级，自身不写自身。";

/** 版本号展示：去掉常见 v 前缀。 */
const fmt = (s?: string | null) => (s ? String(s).replace(/^v/i, "") : "—");

export function AboutCard() {
  const [ver, setVer] = useState<VerInfo | null>(null);          // 面板
  const [logOpen, setLogOpen] = useState(false);
  const [logKind, setLogKind] = useState<"program" | "guard">("program");
  const [logText, setLogText] = useState("");
  const { busy, run } = useConsoleAction();

  // 更新日志：按需拉取文本，失败给出明确提示而非静默。
  const openLog = useCallback(async (kind: "program" | "guard") => {
    setLogKind(kind);
    setLogText("");
    setLogOpen(true);
    try {
      const text = kind === "program" ? await consoleApi.programChangelog() : await consoleApi.guardChangelog();
      setLogText(text || "（无内容）");
    } catch (e) {
      setLogText("加载失败：" + String(e));
    }
  }, []);

  // ── 本地版本（无网络 I/O，进卡即显示）：/guard/version（编译期常量）──
  const load = useCallback(async () => {
    const core = await consoleApi.guardVersion().catch(() => null);
    setVer(core || {});
  }, []);
  useEffect(() => { void load(); }, [load]);

  // ── 检查更新（源码形态经 /guard/version/check 比对待发布提交）──
  const check = async () => {
    await run("chk", async () => {
      const local = await consoleApi.guardVersion().catch(() => null);
      let coreMsg = "面板：状态未知";
      if (local?.upstream === "git-repo") {
        const g = await consoleApi.guardVersionCheck().catch(() => null);
        setVer({ ...(local || {}), ...(g || {}) });
        coreMsg = g?.updateAvailable
          ? "面板有上游更新（当前提交 " + (g.commit || local?.commit || "—") + "）"
          : "面板已是最新（提交 " + (local?.commit || g?.commit || "—") + "）";
      } else {
        setVer(local || {});
        coreMsg = "面板当前版本 " + fmt(local?.version);
      }
      (ver?.updateAvailable ? toast.warning : toast.success)(coreMsg);
    }, { refresh: false });
  };

  // 面板更新：**唯一写入者 = 安卓容器 OTA**。
  //   面板不能调用面板端点安装（/self-update/apply 已下架 = 410）；经消息桥请容器宿主执行。
  const applyCoreUpdate = async () => {
    if (!hasHostBridge()) { toast.error("面板更新由安卓容器执行：请在容器面板中操作。"); return; }
    if (!window.confirm("发现面板新版本 " + fmt(ver?.latest) + "，是否立即更新？\n\n面板将由安卓容器安装，并自动重启面板进程。")) return;
    await run("upd", async () => {
      const r = await requestPanelUpdate();
      if (!r.ok) { toast.error(r.error || "更新失败"); return; }
      const v = fmt(r.version || ver?.latest);
      if (r.restartUncertain) toast.warning("面板已更新至 " + v + "，但面板进程可能未自动重启，请手动确认。");
      else toast.success("面板已更新至 " + v + "，已重启。");
    }, { refresh: true });
  };

  const coreUpdate = Boolean(ver?.updateAvailable && ver?.latest && ver.latest !== (ver?.installed || ver?.version));

  return (
    <Card>
      <CardTitle
        title="关于"
        subtitle={PRODUCT_NAME}
        actions={
          <Button size="sm" disabled={busy === "chk"} onClick={() => void check()} variant="outline">
            <RefreshCw className={cn("size-3.5", busy === "chk" && "animate-spin")} />
            检查更新
          </Button>
        }
      />
      <div className="grid gap-3 px-5 py-4">
        {/* 面板版本 */}
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3">
          <span className="text-xs text-muted-foreground">面板版本</span>
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {fmt(ver?.installed || ver?.version)}
            {coreUpdate ? (
              <>
                <Pill tone="warn">可更新 {fmt(ver?.latest)}</Pill>
                {hasHostBridge() ? (
                  <Button size="chip" disabled={busy === "upd"} onClick={() => void applyCoreUpdate()} variant="outline">
                    <RefreshCw className={cn("size-3", busy === "upd" && "animate-spin")} />更新
                  </Button>
                ) : (
                  <Pill tone="off">请在安卓容器中更新</Pill>
                )}
              </>
            ) : null}
          </span>
        </div>
        <p className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
          {PRODUCT_DESC}
        </p>
        {/* 更新日志入口（后端 /changelog 与 /guard/changelog） */}
        <div className="flex items-center gap-2 border-t border-border/60 pt-3">
          <Button size="chip" variant="outline" onClick={() => void openLog("program")}>
            Lob OS 更新日志
          </Button>
          <Button size="chip" variant="outline" onClick={() => void openLog("guard")}>
            面板更新日志
          </Button>
        </div>
      </div>
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{logKind === "program" ? "Agent Program 更新日志" : "面板更新日志"}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
            {logText || "加载中…"}
          </pre>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
