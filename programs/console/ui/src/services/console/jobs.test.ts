import { describe, expect, it } from "vitest";
import { pollJob } from "./jobs";

// A2/A3 断点修复的轮询器单测：终态识别 / job-not-found 短路 / 超时 / 重试 / 中止。
describe("pollJob 任务轮询", () => {
  it("running → done：命中终态即返回", async () => {
    const seq = [{ state: "running" }, { state: "running" }, { state: "done", restarted: 2 }];
    let i = 0;
    const r = await pollJob(async () => seq[Math.min(i++, seq.length - 1)], { intervalMs: 1 });
    expect(r.state).toBe("done");
    expect((r.snapshot as { restarted?: number }).restarted).toBe(2);
    expect(i).toBe(3);
  });

  it("running → failed：带出 error", async () => {
    const seq = [{ state: "running" }, { state: "failed", error: "磁盘满" }];
    let i = 0;
    const r = await pollJob(async () => seq[Math.min(i++, seq.length - 1)], { intervalMs: 1 });
    expect(r.state).toBe("failed");
    expect(r.error).toBe("磁盘满");
  });

  it("后端返回 job not found：短路为 failed（不无限轮询）", async () => {
    let calls = 0;
    const r = await pollJob(async () => { calls++; return { error: "job not found" }; }, { intervalMs: 1, timeoutMs: 50 });
    expect(r.state).toBe("failed");
    expect(calls).toBe(1);
  });

  it("持续 running：超时返回 timedOut 且保留最后快照", async () => {
    const r = await pollJob(async () => ({ state: "running", restarted: 1 }), { intervalMs: 5, timeoutMs: 30 });
    expect(r.state).toBe("running");
    expect(r.timedOut).toBe(true);
    expect((r.snapshot as { restarted?: number }).restarted).toBe(1);
  });

  it("单次查询抛错：不中断，后续成功仍能到终态", async () => {
    let i = 0;
    const r = await pollJob(async () => {
      i++;
      if (i === 1) throw new Error("network");
      return { state: "done" };
    }, { intervalMs: 1 });
    expect(r.state).toBe("done");
  });

  it("中止信号：立即返回且标记已取消", async () => {
    const r = await pollJob(async () => ({ state: "running" }), { intervalMs: 1, signal: { aborted: true } });
    expect(r.state).toBe("running");
    expect(r.error).toBe("已取消");
  });

  it("onTick 回调异常不影响轮询", async () => {
    const r = await pollJob(async () => ({ state: "done" }), { intervalMs: 1, onTick: () => { throw new Error("ui"); } });
    expect(r.state).toBe("done");
  });
});
