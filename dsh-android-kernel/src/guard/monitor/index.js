'use strict';

// 领域：监控（monitor）——只管探测「原生 / 沙箱实例还活着吗」，输出状态。
// 统一对原生与沙箱实例适用：端口 + 监听 pid + cmdline 特征判定，绝不拉起/绝不接管/绝不做任何生命周期动作。
// 监控的结果仅作为观测/决策依据；是否拉起由守护(guardian)依据 monitor 开关决定。
// 守卫自身生命周期与这些目标完全隔离。

const pidlook = require('../../platform/os/pidlookup');
const probeModule = require('./probe');

/** 端口是否被监听（占用检查，纯探测）。 */
function isPortListening(host, port, timeoutMs) {
  return probeModule.portListening(host, port, timeoutMs || 1000);
}

/**
 * 统一目标在线判定核心。
 * 语义：up/running 只以「端口有进程在监听」为准（探测只管在不在）；
 *       isDsh 仅作标注（接管时由 supervisor 用启动命令精确校验"是不是我们的 DSH"），
 *       不再参与在线判定——避免"DSH 装在路径不含 dsh 的目录就永不在线"这类误判。
 */
function pidState(port) {
  const pid = pidlook.findListeningPid(port);
  if (pid === null) return { pid: null, isDsh: false };
  return { pid, isDsh: pidlook.isDshCmdline(pid) };
}

/**
 * 统一健康探测（三层）：
 *  - L1 端口在线（up）：端口可连且有监听 pid；
 *  - L2 HTTP 健康（httpOk）：GET healthUrl 2xx（httpProbeEnabled=false 时退化为 up）；
 *  @param opts { portTimeoutMs?, httpProbeEnabled?, healthUrl?, httpTimeoutMs? }
 *  @returns {{ up:boolean, pid:number|null, isDsh:boolean, httpOk:boolean, httpStatus:number|null }}
 */
async function probe(host, port, opts) {
  const o = opts || {};
  const listening = await isPortListening(host, port, o.portTimeoutMs || 1200);
  if (!listening) return { up: false, pid: null, isDsh: false, httpOk: false, httpStatus: null };
  const { pid, isDsh } = pidState(port);
  const up = pid !== null;
  let httpOk = false;
  let httpStatus = null;
  if (o.httpProbeEnabled !== false && o.healthUrl) {
    const r = await probeModule.httpProbe(o.healthUrl, o.httpTimeoutMs || 3000);
    httpOk = r.ok;
    httpStatus = r.status;
  } else {
    // 关闭 HTTP 探测（自定义非 HTTP 命令）：端口在线即视为健康
    httpOk = up;
  }
  return { up, pid, isDsh, httpOk, httpStatus };
}

/** 探测单个实例状态（沙箱/原生实例）。inst = { port }。
 *  @returns {{ pid:number|null, running:boolean, isDsh:boolean, phase:string }} */
function probeInstance(inst) {
  const { pid, isDsh } = pidState(inst.port);
  const running = pid !== null;
  return { pid, running, isDsh, phase: running ? 'RUNNING' : 'STOPPED' };
}

module.exports = { probe, probeInstance, isPortListening };
