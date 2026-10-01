
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
// 端口手工分配在安全段（避开 OS ephemeral 与生产池）；跨文件不撞号靠人工规划，T1 兜底。
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-verify-'));
const MOCK = path.join(ROOT, 'test', 'mock-target.js');

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? '  ← ' + extra : '')); };

(async () => {
  // 1. 构造 supervisor，验证统一端口管理（固定登记 + 动态分配）
  //
  // Android 内核：实例（沙箱）与远程控制（relay/frpc）两域已删除（plan §4），
  // 本测试原有的「沙箱实例加载 / sup.lan syncProxy / relay 转发 / reconcile」用例随之移除
  // （删测试即删被测功能）；保留**端口注册表**验证——端口管理属保留域（guard/lifecycle/ports）。
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  // 动态空闲端口：规避固定端口与历史 TIME_WAIT 残留的偶发绑定冲突（EADDRINUSE）
  const freePort = () => new Promise((res) => {
    const srv = http.createServer();
    srv.on('error', () => res(0));
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
  const apiPort = await freePort();
  const targetPort = await freePort();
  const stateDir = path.join(TMP, 'sup');
  fs.mkdirSync(stateDir, { recursive: true });
  const cfg = {
    command: ['node', MOCK, String(targetPort)],
    healthUrl: 'http://127.0.0.1:' + targetPort + '/',
    apiHost: '127.0.0.1', apiPort,
    stateFile: path.join(stateDir, 'state.json'),
    logFile: path.join(stateDir, 'events.log'),
    supervisorLogFile: path.join(stateDir, 'supervisor.log'),
    dshLogFile: path.join(stateDir, 'dsh.log'),
    upgradeLogFile: path.join(stateDir, 'upgrade.log'),
  };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  // main(原生主干)元数据：守卫核心存储 dsh-main.json（Android 内核只剩 guardian 守护开关）
  fs.writeFileSync(path.join(stateDir, 'dsh-main.json'), JSON.stringify({ guardian: true }));
  // 起 mock 在 targetPort（main 的目标）上
  const mockMain = spawn('node', [MOCK, String(targetPort)], { stdio: 'ignore' });
  // 确定性就绪等待：轮询 mock HTTP 探活（替代固定 900ms——负载下可能未就绪即断言导致抖动失败）
  const waitReady = (port) => new Promise((res) => {
    const t0 = Date.now();
    const tryOnce = () => {
      const rq = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (s) => { s.resume(); res(true); });
      rq.on('error', () => { if (Date.now() - t0 > 6000) res(false); else setTimeout(tryOnce, 150); });
    };
    tryOnce();
  });
  const rdyMain = await waitReady(targetPort);
  check('mock 目标就绪（就绪轮询）', rdyMain, JSON.stringify({ main: rdyMain }));

  const sup = new Supervisor(cfg, cfgPath);
  // main 为守卫核心服务：视图经 dshMainView()（Android 内核无沙箱实例数组）
  const instMain = sup.dshMainView();
  check('main(守卫核心视图)存在且 guardian 已持久化', !!instMain && instMain.guardian === true, JSON.stringify(instMain && { id: instMain.id, guardian: instMain.guardian }));

  // 2. 端口注册表：固定端口登记 + 动态分配避开
  const ports = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports')).shared;
  sup._registerFixedPorts();
  check('固定端口已登记', ports.get('dsh-main') === targetPort && ports.get('supervisor-api') === apiPort);
  const relayPort = await ports.allocate('proxyInstance');
  // 2026-09 池重构：动态池选址避开 OS 动态端口范围（Linux ip_local_port_range=32768-60999），
  // 落 IANA User 段低位（默认 managed 池 20000-23999）。断言按「逻辑段所属池区间」而非旧硬编码。
  const relayPool = ports.rangeOf('proxyInstance');
  check('proxyInstance 端口落在其动态池区间内', relayPort >= relayPool.base && relayPort < relayPool.base + relayPool.count, JSON.stringify({ port: relayPort, pool: relayPool }));
  check('proxyInstance 端口避开固定端口', relayPort !== targetPort && relayPort !== apiPort);

  // 3. 同一逻辑段连续分配：端口互不重复（动态池不复用在用的端口）
  const second = await ports.allocate('proxyInstance');
  check('同一逻辑段连续分配端口互不重复', second !== relayPort, JSON.stringify({ first: relayPort, second }));

  // 清理
  try { mockMain.kill('SIGKILL'); } catch {}
  const failed = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
