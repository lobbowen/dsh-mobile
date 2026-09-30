'use strict';

// 反向代理应用注册表：每个反代产品=一个独立、完整、第三方的开源「应用」。
// 我们只对接（安装npx/启停/探活/转发/配额感知/自动更新检测），绝不 fork / 二改。
// 新增反代产品：加一条定义即可，前端目录自动出现。
// 注意：产品内不再内置任何“测试”供应商（dry-run 已移除，仅由测试自行注册 mock 应用）。

const PROXY_APPS = {
  commandcode: {
    id: 'commandcode',
    name: 'Command Code Proxy',
    pkg: 'commandcode-api-proxy',
    // 官方运行方式（npx 一键）—— 完整独立发行版
    command: ['npx', '--yes', 'commandcode-api-proxy', '--host', '127.0.0.1', '--port', '{{port}}', '--api-key', '{{key}}'],
    healthPath: '/health',
    modelPath: '/v1/models',
    upstream: 'https://api.commandcode.ai',
    // 实例环境契约（proxy 模式类按 app.env 注入，不内联供应商 env）：
    //  keyEnv=账号密钥注入的 env 名（只经 env 传递，绝不进 cmdline）；
    //  env/超时等一律【不】注入（2026-09 回归最早纯净态）：commandcode-api-proxy 跑完全默认配置
    //    （idle 120s / upstream 600s，作者设计值）。git 证据：最早 8867942 仅 keyEnv 注入、78 万 token
    //    顺畅；后加 CC_IDLE_TIMEOUT_MS=0 等自我干预才是「后来出问题」起点。keyEnv 仅账号密钥经 env 传。
    keyEnv: 'CC_API_KEY',
    repo: 'thaolaptrinh/commandcode-api-proxy',
    // 自动更新：最新版本从 npm registry 查（同一 package 名）。空则跳过版本检查。
    registry: 'commandcode-api-proxy',
    versionRefreshMs: 6 * 3600 * 1000, // 默认 6h 查一次 npm
    // 每账号配额来源：Command Code 官方 /alpha/billing/credits（订阅面，Go 套餐可用；Bearer 各账号 key）。
    // windowMap: rolling=5h 窗口、weekly=周窗口；无月窗口（credits.monthlyCredits 无 cap，故 monthly 置 null）。
    // quota 来源（2026-09 真实采样核验）：
    //  - /alpha/billing/credits：窗口（5h/weekly）+ credits 池（月额度用尽/低余额判定）——无 period 字段；
    //  - /alpha/billing/subscriptions：currentPeriodEnd = 月额度随订阅续期重置的精确时刻
    //    （月度重置调度/展示用；仅 credits-limited 账号按 6h 缓存低频取，防风控）。
    quota: {
      type: 'commandcode-billing',
      apiBase: 'https://api.commandcode.ai',
      creditsPath: '/alpha/billing/credits',
      subscriptionsPath: '/alpha/billing/subscriptions',
      windowMap: { rolling: 'fiveHour', weekly: 'weekly', monthly: null },
      // 月度配额上限（$/月）：Command 订阅含 $10/月总配额池——周窗口从池内扣（实测 weekly.used +
      // monthlyCredits.remaining = 10），解析层据此推导 monthly.percent（真实月用量，非无月窗口）。
      // 2026-09 用户纠正：Command 有月额度（$10 订阅），前端每月格子必须显示真实百分比。
      monthlyCapUsd: 10,
    },
    real: true,
  },
};

module.exports = { PROXY_APPS };
