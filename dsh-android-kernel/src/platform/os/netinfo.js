'use strict';

// ★ 平台化「本机局域网可访问地址」枚举 —— Android-only ★
//
// 语义（三端时代就已定下，安卓沿用）：返回「局域网内设备真正能访问」的 IPv4 列表 ——
//   · 排除回环 / 链路本地（127.*、169.254.*）
//   · 排除虚拟网卡（virbr/veth/docker/vmnet/br-/lo/vEthernet）
//   · 去重复
//
// 实现：**只用 Node 的 os.networkInterfaces()**，不再 spawn 任何外部二进制。
//   · 安卓（toybox）的 `ip` 输出格式与 iproute2 有出入，且容器内未必可用；
//   · 既不依赖 `ip`/`ifconfig`，也就无需 PowerShell 分支。
//
// ⚠ 已删除的 PC 遗留（勿回潮）：
//   · linux  `ip route show default` + `ip -o addr show`（iproute2 专有）
//   · darwin `route -n get default` + `ifconfig <iface>`
//   · win32  PowerShell `Get-NetRoute` / `Get-NetIPAddress`
//   任何平台差异一律不允许泄漏回业务层（settings-view 只调 lanAddresses()）。

const os = require('node:os');

/** 虚拟/环回网卡前缀（LAN 地址枚举应排除）。 */
const VIRTUAL_IFACE = /^(virbr|veth|docker|vmnet|br-|lo|vEthernet|dummy|tun|tap)/;

function usable(addr) {
  return !!addr && !addr.startsWith('127.') && !addr.startsWith('169.254.');
}

/** 从若干 (iface, addr, family) 记录里挑地址：虚拟网卡排除、去重复、稳定排序。
 *  @param {{iface:string, addr:string}[]} records
 *  @returns {string[]} */
function pick(records) {
  const out = [];
  for (const r of records) {
    if (!usable(r.addr)) continue;
    if (VIRTUAL_IFACE.test(r.iface || '')) continue;
    out.push(r.addr);
  }
  return [...new Set(out)];
}

/** 枚举本机局域网可访问 IPv4 地址（**任何情况都不抛异常**；失败返回空数组）。 */
function lanAddresses() {
  try {
    const nets = os.networkInterfaces();
    const records = [];
    for (const iface of Object.keys(nets || {})) {
      for (const n of nets[iface] || []) {
        // 只取 IPv4（family 可能是 'IPv4' 或数字 4，取决于 Node 版本）
        if (n.family !== 'IPv4' && n.family !== 4) continue;
        records.push({ iface: iface, addr: n.address });
      }
    }
    return pick(records);
  } catch {
    return [];
  }
}

module.exports = { lanAddresses, pick, VIRTUAL_IFACE, supported: true, PLATFORM: process.platform };
