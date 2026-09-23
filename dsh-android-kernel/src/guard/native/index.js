'use strict';

// 领域：原生 DeepSeek Harness（原生 DSH，独立模块，不作为沙箱实例）。
// 管理原生 DSH 的生命周期状态 / 启动命令 / 一键安装 / 自动注册等原生专属关注点。
// 与沙箱实例(domain/instance)彻底分开；监控/守护由 domain/monitor + domain/guardian 统一覆盖。

const fs = require('node:fs');

/** 组装原生 DSH 启动命令：存在插件启停覆盖层时附加 --patch 参数。
 * DSH CLI（@deepseek-ai/dsh lib/bin.js）的 web 子命令带 rejectParentOptions 守卫：
 * --patch 置于子命令之前会被判为“父级选项”直接报错退出
 * （error: web takes none of parent --profile, --patch, ...），必须放在子命令之后：
 * dsh web --patch <overlay> --port <targetPort>
 * dsh --patch <overlay> web --port <targetPort> exit:1
 * 统一端口注入：确保命令携带 --port <targetPort>（端口由统一配置/动态注册决定）——
 * 若命令已含 --port/-p 则更新为其 targetPort 值；否则在子命令后追加。 */
function nativeCommand(config, pluginManager) {
  const command = config.command || [];
  const [runtime, bin, ...rest] = command;
  let parts = command;
  if (pluginManager && pluginManager.overlayFile && fs.existsSync(pluginManager.overlayFile)) {
    // 子命令形态（dsh web …）：--patch 紧跟子命令词之后（web 子命令自声明 --patch）；
    // 根选项形态（dsh --profile web …，rest[0] 以 '-' 开头）：--patch 保持根级（根程序自声明）。
    const sub = rest.length > 0 ? String(rest[0]) : '';
    if (sub && !sub.startsWith('-')) {
      parts = [runtime, bin, sub, '--patch', pluginManager.overlayFile, ...rest.slice(1)];
    } else {
      parts = [runtime, bin, '--patch', pluginManager.overlayFile, ...rest];
    }
  }
  // 注入/更新 --port <targetPort>（统一端口来源；无则追加）
  const out = [];
  let portSet = false;
  for (let i = 0; i < parts.length; i++) {
    const a = String(parts[i]);
    if (a === '--port' || a === '-p') {
      out.push(a, String(config.targetPort)); i++; portSet = true;
    } else if (/^--port=/.test(a)) {
      out.push('--port=' + config.targetPort); portSet = true;
    } else {
      out.push(parts[i]);
    }
  }
  if (!portSet && config.targetPort) out.push('--port', String(config.targetPort));
  return out;
}

module.exports = { nativeCommand };
