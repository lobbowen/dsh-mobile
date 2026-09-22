/**
 * 设置 — 镜像源区块（独立自治：只依赖 registry 端点；与启动、版本环境解耦——
 * 自身加载、自身编辑，registry 失败只影响本卡，其他设置不受影响。）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, RadioGroup, RadioGroupItem } from "../../../framework/ui";
import { Input } from "../../../framework/ui/input";
import {
  supervisorApi, type RegistryInfo,
} from "../../../services/supervisor";
import { useSupervisorAction } from "../useSupervisorAction";
import { Card, CardTitle, Pill } from "../widgets";
import { cn } from "../../../framework/utils";

export function RegistryCard() {
  const [reg, setReg] = useState<RegistryInfo | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [manualOrigin, setManualOrigin] = useState("");
  const [newOrigin, setNewOrigin] = useState("");
  const [expanded, setExpanded] = useState(false); // 折叠受控态（标准 Collapsible 组件）
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { busy, run } = useSupervisorAction();

  // 展开后把「候选镜像列表」trigger 滚动到视口顶部（block:start）——页面跟随到这张卡片，
  // 展开的候选列表从 trigger 下自然排开完整可见（而非滚到列表末尾、丢卡片头）
  useEffect(() => {
    if (!expanded || !triggerRef.current) return;
    const t = window.setTimeout(() => {
      const el = triggerRef.current;
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 320);
    return () => window.clearTimeout(t);
  }, [expanded]);

  // 区块自加载（独立失败：镜像源端点异常只让本卡降级，不影响启动/版本）
  const load = useCallback(async () => {
    const r = await supervisorApi.registry().catch(() => null);
    setReg(r);
  }, []);
  useEffect(() => { void load(); }, [load]);
  // reg 到达后回填编辑器
  useEffect(() => {
    if (!reg) return;
    setMode(reg.mode || "auto");
    setCandidates((reg.candidates ?? []).map((c) => c.origin));
    setManualOrigin(reg.manualOrigin || "");
  }, [reg]);

  const addCandidate = () => {
    const v = newOrigin.trim();
    if (!/^https?:\/\//.test(v)) { toast.error("请输入合法的镜像 URL"); return; }
    if (candidates.includes(v)) { toast.info("已在列表中"); return; }
    setCandidates((c) => [...c, v]); setNewOrigin("");
  };
  async function saveReg() {
    const body: { mode: "auto" | "manual"; origins: string[]; manualOrigin?: string } = { mode, origins: candidates };
    if (mode === "manual") {
      if (!/^https?:\/\//.test(manualOrigin.trim())) { toast.error("手动模式需提供合法镜像 URL"); return; }
      body.manualOrigin = manualOrigin.trim();
    }
    await run("reg", () => supervisorApi.registrySet(body), { success: "已保存镜像配置", refresh: false, onDone: () => void load() });
  }
  async function refreshReg() {
    await run("regr", () => supervisorApi.registryRefresh(), { success: "已探测镜像", refresh: false, onDone: () => void load() });
  }

  // 候选镜像 → 延迟毫秒(从 probes 查; 未探测返回 null)
  const latencyOf = (origin: string): number | null => {
    const p = (reg?.probes ?? []).find((x) => x.origin === origin);
    return p && p.ok ? p.latencyMs : null;
  };

  return (
    <Card>
      <CardTitle title="镜像源" subtitle="npm 拉取 / 更新检测共用此源" />
      <div className="grid gap-3 px-5 py-4">
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as "auto" | "manual")} className="flex gap-3">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
            <RadioGroupItem value="auto" id="reg-auto" />
            <span>自动（按延迟选最快）</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
            <RadioGroupItem value="manual" id="reg-manual" />
            <span>手动（固定指定）</span>
          </label>
        </RadioGroup>
        {mode === "manual" ? (
          <div className="grid gap-1.5">
            <div className="flex gap-2">
              <Input placeholder="https://registry.npmmirror.com" value={manualOrigin} onChange={(e) => setManualOrigin(e.target.value)} className="flex-1" />
              <Button variant="outline" onClick={() => void testLatency(manualOrigin)}>测试</Button>
            </div>
          </div>
        ) : null}
        {/* 候选镜像列表（标准 Collapsible：折叠时仅显示当前使用项，展开看全列表） */}
        <Collapsible open={expanded} onOpenChange={setExpanded} className="grid gap-1">
          <CollapsibleTrigger ref={triggerRef}>
            <span className="text-xs font-medium text-foreground">候选镜像列表（{candidates.length}）</span>
            {expanded ? <ChevronUp className="size-3.5 text-muted-foreground" /> : <ChevronDown className="size-3.5 text-muted-foreground" />}
          </CollapsibleTrigger>
          {/* 折叠态：列表收起时显示当前使用项（列表本身已用「当前」徽标标注，无需额外文案） */}
          {!expanded ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border/70 px-3 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <Pill tone="ok">当前</Pill>
                <code className="truncate font-mono text-xs text-muted-foreground">{reg?.origin || "未选择"}</code>
              </div>
              {reg?.origin && latencyOf(reg.origin) != null ? (
                <span className="shrink-0 text-xs font-medium tabular-nums">{latencyOf(reg.origin)}ms</span>
              ) : null}
            </div>
          ) : null}
          <CollapsibleContent>
            {/* 候选列表自然展开融入页面滚动流（无内部限高滚动——展开后页面跟随到底） */}
            <div className="rounded-md border border-border/70">
              {candidates.map((o, i) => (
                <div key={i} className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0">
                  <div className="flex min-w-0 items-center gap-2">
                    {reg?.origin === o ? <Pill tone="ok">当前</Pill> : null}
                    <code className="truncate font-mono text-xs text-muted-foreground">{o}</code>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {latencyOf(o) != null ? (
                      <span className="text-xs font-medium tabular-nums" title="延迟毫秒数（自动探测）">
                        {latencyOf(o)}<span className="text-muted-foreground/60">ms</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                    <Button size="chip" variant="ghost" onClick={() => setCandidates((c) => c.filter((x) => x !== o))} title="移除该候选镜像"><Trash2 className="size-3.5 text-destructive" /></Button>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
        <div className="flex gap-2">
          <Input placeholder="https://… 添加自定义镜像" value={newOrigin} onChange={(e) => setNewOrigin(e.target.value)} className="flex-1" onKeyDown={(e) => { if (e.key === "Enter") addCandidate(); }} />
          <Button variant="outline" onClick={addCandidate}><Plus className="size-4" />添加</Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={busy === "regr"} onClick={() => void refreshReg()} variant="outline"><RefreshCw className={cn("size-3.5", busy === "regr" && "animate-spin")} />重新探测</Button>
          <Button disabled={busy === "reg"} onClick={() => void saveReg()}>保存</Button>
        </div>
      </div>
    </Card>
  );
}

/** 测试手动镜像可达性（**经同源后端**探测，不改配置）。
 *
 *  ⚠ 2026-09-13 修复（P2）：本条原为浏览器**直连**用户填写的镜像源
 *    （fetch(url + "/-/ping")），而本页由内核伺服且带 CSP connect-src 'self'
 *    （src/api/index.js）→ 浏览器**在发起前即按 CSP 拦截**，fetch 立刻 reject
 *    → catch 统一 toast「探测失败」。
 *    后果：该按钮对**任何**地址恒报失败、换网络也无解，用户会误以为镜像损坏；
 *    且 UI 无法区分「真的不可达」与「被策略阻断」。
 *    改走 POST /dist/registry/probe（服务端探测，不受页面 CSP 约束），
 *    并复用内核选源的**同一探测规格**，避免「测试说可达、实际选源不同」的分叉。
 */
async function testLatency(url: string) {
  if (!/^https?:\/\//.test(url)) { toast.error("请输入合法镜像 URL"); return; }
  toast.info("测试中…");
  try {
    const r = await supervisorApi.registryProbe(url.replace(/\/+$/, ""));
    if (r && r.ok === true && typeof r.latencyMs === "number") {
      toast.success("可达，延迟 " + r.latencyMs + " ms");
    } else if (r && typeof r.error === "string" && r.error) {
      toast.error("探测失败：" + r.error);
    } else {
      toast.error("不可达");
    }
  } catch (e) {
    toast.error("探测失败：" + (e instanceof Error ? e.message : String(e)));
  }
}
