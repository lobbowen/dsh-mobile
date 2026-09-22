/**
 * ============================================================================
 * supervisor 运行态轮询中心（对齐老 UI unifiedTick 语义：单源快照 → 视图只读）
 * ============================================================================
 * - start() 每 2s 并行拉运行态 + 增量事件（after=seq），写入快照并发给订阅者
 * - 任意写操作后可 refresh()（立即同步一次）
 * - 纯 JS 事件订阅（set 通知），页面用 useSyncExternalStore 或 useEffect 消费
 * ============================================================================
 */
import { supervisorApi } from "./client";
import type {
  EventsPage, PortsResponse, ProvidersResponse, RouterStatus, SupervisorStatus,
} from "./types";

export interface SupervisorSnapshot {
  status: SupervisorStatus | null;
  router: RouterStatus | null;
  providers: ProvidersResponse | null;
  /** 端口注册表快照（R4 修复：从 PortPanel 独立 5s 轮询收敛进统一心跳） */
  ports: PortsResponse | null;
  events: EventsPage["events"];
  eventsSeq: number;
  online: boolean;
}

function empty(): SupervisorSnapshot {
  return {
    status: null, router: null, providers: null, ports: null,
    events: [], eventsSeq: 0, online: false,
  };
}

type Listener = (snap: SupervisorSnapshot) => void;
const listeners = new Set<Listener>();
let snap = empty();
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
/** 事件增量拉取的 in-flight 守卫：refreshEvents 与 syncAll 相互独立，
 *  防止慢网下并发 refresh()/心跳交叠导致同批事件双插（R1 修复）。 */
let eventsBusy = false;

function emit() { for (const l of listeners) l(snap); }
function setPartial(p: Partial<SupervisorSnapshot>) { snap = { ...snap, ...p }; emit(); }

async function syncAll() {
  if (busy) return;
  busy = true;
  try {
    const [status, router, providers, ports] = await Promise.all([
      supervisorApi.status().catch(() => null),
      supervisorApi.routerStatus().catch(() => null),
      supervisorApi.providers().catch(() => null),
      supervisorApi.ports().catch(() => null),
    ]);
    const online = !!status;
    // R4 修复：心跳不再附带 /tasks —— snap.tasks 无消费者（TasksPage 自管本地 state + 手动刷新），
    // 每 2s 白拉一次低频任务列表属于无效网络开销。
    setPartial({ status, router, providers, ports, online });
  } catch {
    setPartial({ online: false });
  } finally {
    busy = false;
  }
}

async function refreshEvents() {
  if (eventsBusy) return;
  eventsBusy = true;
  try {
    const r = await supervisorApi.events(snap.eventsSeq, 60);
    if (r.events && r.events.length) {
      // 后端增量升序 → 新批次在前（老 UI 语义：数组头 = 最新）。
      // 按 seq 去重兜底：即使 in-flight 曾交叠/后端游标回退，也不让同 seq 双插。
      const seen = new Set<number>();
      const merged: EventsPage["events"] = [];
      for (const e of [...r.events].reverse().concat(snap.events)) {
        if (e.seq === undefined) { merged.push(e); continue; }
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        merged.push(e);
      }
      setPartial({
        events: merged.slice(0, 60),
        eventsSeq: Math.max(snap.eventsSeq, r.seq),
      });
    }
  } catch { /* 静默 */ }
  finally { eventsBusy = false; }
}

export const supervisorStore = {
  get snapshot() { return snap; },
  /** 订阅快照变更；返回取消函数 */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** 启动 2s 统一轮询（事件高频 + 运行态）；首次立即同步 */
  start() {
    if (started) return;
    started = true;
    void refreshEvents();
    void syncAll();
    timer = setInterval(() => {
      void refreshEvents();
      void syncAll();
    }, 2000);
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null; started = false;
    // 卸载后彻底清场：事件保留（宿主重挂载时可续看），但复位运行态守卫标记
    busy = false; eventsBusy = false;
  },
  /** 任意写操作后立即同步一次（操作 → 同步 → 渲染） */
  refresh() {
    void refreshEvents();
    void syncAll();
  },
  /** 测试专用：清空快照与订阅（仅在 vitest 中调用） */
  _resetForTest() {
    listeners.clear();
    snap = empty();
    busy = false; eventsBusy = false; started = false;
    if (timer) clearInterval(timer); timer = null;
  },
};
