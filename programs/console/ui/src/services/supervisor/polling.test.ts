/**
 * polling.ts 单元测试：事件增量去重 + in-flight 守卫
 * vi.stubGlobal 注入 fetch，验证 refreshEvents 合并去重与并发守卫行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supervisorStore } from "./polling";

/** 等待事件循环微任务链（refresh 内部 async 无句柄可 await，需拍两拍） */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 构造 /events 返回，含升序 seq 的事件批次 */
function eventsResponse(seq: number, seqList: number[]): Response {
  const events = seqList.map((s) => ({ seq: s, type: "running", ts: new Date().toISOString() }));
  return new Response(JSON.stringify({ seq, events }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function emptyResponse(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** 心跳真实消费的端点（与 polling.ts syncAll 一致：status / router / providers / ports）
 *  ⚠ 已删除的端点（勿回潮）：/instances、/lan-access、/lan/frp —— 实例管理与远程控制域已整体移除。 */
const baseEndpoints: Record<string, object> = {
  "/status": { phase: "RUNNING", dshPid: 1 },
  "/router/status": { running: false, usage: {} },
  "/router/providers": { presets: [], providers: [], proxyApps: [] },
  "/ports": { records: [] },
};

function installFetch(eventsHandler: (seq: number) => Response) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/events") {
      const after = Number(new URL(url, "http://localhost").searchParams.get("after") || 0);
      return Promise.resolve(eventsHandler(after));
    }
    return Promise.resolve(emptyResponse(baseEndpoints[path] ?? { error: "not-found" }));
  }));
}

beforeEach(() => {
  supervisorStore._resetForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
  supervisorStore.stop();
  supervisorStore._resetForTest();
});

describe("supervisorStore 事件合并", () => {
  it("按 seq 去重：两批含重叠 seq 时最终事件无重复", async () => {
    let call = 0;
    // 第一批 [(1,2,3)]，第二批仍返回 [(1,2,3)]（模拟后端游标回退/并发内联）
    installFetch(() => {
      call += 1;
      return eventsResponse(3, [1, 2, 3]);
    });
    // 手动触发 refreshEvents 两次（refresh 内部含 events 刷新）
    supervisorStore.refresh();
    supervisorStore.refresh();
    await settle();
    const events = supervisorStore.snapshot.events;
    // 批次反转保证最新在前；两批同 seq → 去重后应为 3 条且 seq 不重复
    expect(events).toHaveLength(3);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(3);
  });

  it("非重叠增量正确拼接并按 seq 推进游标", async () => {
    // 按游标返回确定批次：after=0 → [1,2,3](seq3)；after=3 → [4,5](seq5)
    installFetch((after) => {
      if (after >= 3) return eventsResponse(5, [4, 5]);
      return eventsResponse(3, [1, 2, 3]);
    });
    supervisorStore.refresh();
    await settle();
    // 首次拉取完成，eventsSeq 推进到 3
    expect(supervisorStore.snapshot.events.map((e) => e.seq)).toEqual([3, 2, 1]);
    supervisorStore.refresh();
    await settle();
    // 第二次按 after=3 增量拉 [4,5]，合并去重后头插 → [5,4,3,2,1]
    const events = supervisorStore.snapshot.events;
    expect(events.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(supervisorStore.snapshot.eventsSeq).toBe(5);
  });

  it("in-flight 守卫：并发 refresh 不因竞态双插", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    installFetch((_seq) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      return eventsResponse(3, [1, 2, 3]);
    });
    // 同时触发多次 refresh（syncAll + refreshEvents 各自独立，events 应有自己的守卫）
    supervisorStore.refresh();
    supervisorStore.refresh();
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore.snapshot.events).toHaveLength(3);
  });
});
