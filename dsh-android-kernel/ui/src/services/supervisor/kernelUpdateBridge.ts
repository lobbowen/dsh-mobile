/**
 * 面板 → 安卓容器宿主（HostBridge）内核更新消息桥（单写入者契约）。
 *
 * 单写入者：内核包的安装/升级唯一写入者是**安卓容器 OTA**（APK / HostBridge），
 * 内核只提供版本读取（/guard/version、/guard/version/check），写端点
 * （/self-update/apply|restart-guard）已下架返回 410 KERNEL_UPDATE_SINGLE_WRITER。
 *
 * 于是面板只能经 postMessage 请求容器宿主代执行 kernel_update_apply。
 * 协议版本由门禁锁定（内核 SW-6 / 容器 HostBridge 侧须同步递增）。
 */

/** 协议版本：任何语义变更必须递增；须与容器 HostBridge 侧常量一致。 */
export const BRIDGE_PROTOCOL_VERSION = 1;

const REQUEST = "dsh:kernel-update-request";
const RESULT = "dsh:kernel-update-result";
const PROGRESS = "dsh:kernel-update-progress";

export type KernelUpdateResult = {
  ok: boolean;
  stage?: string | null;
  version?: string | null;
  restartUncertain?: boolean;
  error?: string | null;
};

/** 是否运行在安卓容器宿主内（无宿主 = 直接用浏览器打开面板，不能更新内核）。 */
export function hasHostBridge(): boolean {
  try { return window.parent !== window; } catch { return false; }
}

/** 请求安卓容器宿主更新内核并等待终结结果。 */
export function requestKernelUpdate(timeoutMs = 6 * 60 * 1000): Promise<KernelUpdateResult> {
  return new Promise((resolve) => {
    if (!hasHostBridge()) {
      resolve({ ok: false, error: "内核更新由安卓容器执行：请在容器面板中操作。" });
      return;
    }
    const requestId = "kupd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    let done = false;
    const finish = (r: KernelUpdateResult) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(r);
    };
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object") return;
      if (d.v !== BRIDGE_PROTOCOL_VERSION) return;
      if (d.type !== RESULT && d.type !== PROGRESS) return;
      if (d.requestId !== requestId) return;
      if (d.type === PROGRESS) return; // 进度消息不终结请求
      finish({
        ok: d.ok === true,
        stage: (d.stage as string) ?? null,
        version: (d.version as string) ?? null,
        restartUncertain: d.restartUncertain === true,
        error: (d.error as string) ?? null,
      });
    };
    const timer = setTimeout(() => finish({ ok: false, error: "容器宿主无响应（更新请求超时）" }), timeoutMs);
    window.addEventListener("message", onMessage);
    try {
      // 宿主帧的 origin 由容器决定（回环 http://127.0.0.1:<port> 或容器自定义协议），
      // 面板无从预知；故请求用 '*'，来源校验由宿主侧负责。
      window.parent.postMessage({ v: BRIDGE_PROTOCOL_VERSION, type: REQUEST, requestId }, "*");
    } catch (e) {
      finish({ ok: false, error: String(e) });
    }
  });
}
