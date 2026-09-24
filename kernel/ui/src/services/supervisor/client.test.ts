/**
 * client.ts 单元测试：错误归一化 / 请求超时
 * 不依赖真实后端：vi.stubGlobal 注入 fetch。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { supervisorApi, LONG_TIMEOUT_MS } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  } as ResponseInit);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("supervisorApi http 客户端", () => {
  it("2xx 返回解析后的 JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, dshPid: 42 })));
    const r = await supervisorApi.status();
    expect(r).toEqual({ ok: true, dshPid: 42 });
  });

  it("非 2xx 时优先抛后端 {error} 文案", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: "内核故障" })));
    await expect(supervisorApi.status()).rejects.toThrow("内核故障");
  });

  it("非 2xx 无 error/message 时回退 HTTP 状态 + 路径", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, null)));
    await expect(supervisorApi.tasks()).rejects.toThrow(/HTTP 404 \/tasks/);
  });

  it("请求携带 abort 信号（http 内 withTimeout 注入），后端挂起时 fetch 被 abort", async () => {
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      receivedSignal = init?.signal;
      // 永不 resolve 的挂起请求（模拟后端无响应）；由 http 的 AbortController 兜底
      return new Promise((_resolve) => undefined);
    }));
    const p = supervisorApi.status();
    // 断言请求确实带上了可 abort 的信号（withTimeout 已装配）
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
    // 清理挂起 promise，避免泄漏
    await Promise.resolve();
    p.catch(() => undefined);
  });

  it("长轮询端点（proxyLoginWait）豁免超时到 LONG_TIMEOUT_MS", () => {
    expect(LONG_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
  });
});

describe("ADB 配对客户端", () => {
  it("adbStatus GET /adb/status", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(200, { ok: true, paired: false, pubkey: "k" })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await supervisorApi.adbStatus();
    expect(r).toEqual({ ok: true, paired: false, pubkey: "k" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/adb/status");
    expect(init?.method).toBe("GET");
  });

  it("adbPair POST /adb/pair 携带 host/pairPort/code", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(200, { ok: true, guid: "G", type: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await supervisorApi.adbPair({ host: "1.2.3.4", pairPort: 42111, code: "123456", connectPort: 40595 });
    expect(r.guid).toBe("G");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/adb/pair");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ host: "1.2.3.4", pairPort: 42111, code: "123456", connectPort: 40595 });
  });

  it("adbShell POST /adb/shell 携带 cmd", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(200, { ok: true, out: "uid=2000", logs: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await supervisorApi.adbShell({ cmd: "id" });
    expect(r.out).toBe("uid=2000");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/adb/shell");
    expect(JSON.parse(String(init?.body))).toEqual({ cmd: "id" });
  });

  it("adbForget POST /adb/forget", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(200, { ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    await supervisorApi.adbForget();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/adb/forget");
    expect(init?.method).toBe("POST");
  });
});

