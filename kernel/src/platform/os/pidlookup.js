'use strict';

// 平台化「进程 / 端口反查」—— Android-only。
//
// 安卓内核跑在容器里，`process.platform === 'linux'`，因此**只保留 Linux(/proc) 语义**：
// · 监听端口反查 pid ：/proc/net/tcp{,6} 的 LISTEN(0A) inode → /proc/<pid>/fd 匹配（ss 兜底）
// · 读进程命令行 ：/proc/<pid>/cmdline
// · 按命令行匹配进程 ：遍历 /proc/<pid>/cmdline（不再依赖 pgrep —— 安卓无 pgrep -a/-f 之别）
//
// 已删除的 PC 遗留（勿回潮）：macOS `lsof -nP -iTCP` / BSD `pgrep -f` + `ps -o command=`、
// Windows `netstat -ano` / `wmic ... get CommandLine` / PowerShell CIM 回退链。
// 安卓不存在这些二进制，留着只会让「三端防线」这类声明再次变成空话。

const fs = require('node:fs');
const ex = require('../exec');

/** 解析 `/proc/net/tcp{,6}` 文本 → 该 port 处于 LISTEN(0A) 的 socket inode 集合。
 *
 * 列序取数据行实测布局：sl(0) local(1) rem(2) st(3) tx:rx(4) tr:when(5) retrnsmt(6)
 * uid(7) timeout(8) inode(9) …（数据行 17 列，表头为 12 名——表头与行不对齐，勿按表头取列；
 * 2026-09 曾误改表头解析导致 inode 取到第 11 列恒错，回退实测列位并保留 ss 兜底）。
 * @returns {Set<string>} 形如 `socket:[12345]`（与 /proc/<pid>/fd 的 link 同名） */
function parseProcNetTcpInodes(txt, port) {
  const inodes = new Set();
  for (const lineRaw of String(txt || '').split('\n')) {
    const cols = lineRaw.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const local = cols[1];
    const st = cols[3];
    const inode = cols[9];
    if (!local || !inode) continue;
    const p = local.split(':')[1];
    if (st === '0A' && p && parseInt(p, 16) === port) inodes.add('socket:[' + inode + ']');
  }
  return inodes;
}

/** 解析 `ss -tlnHp` 输出 → `users:(("node",pid=123,fd=20))` 里的 pid 或 null。 */
function parseSsPid(out) {
  const m = out && /pid=(\d+)/.exec(String(out));
  return m ? Number(m[1]) : null;
}

function linuxListeningInodes(port) {
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const x of parseProcNetTcpInodes(txt, port)) inodes.add(x);
  }
  return inodes;
}

/** /proc 内所有 pid（数字目录名）。 */
function allPids() {
  try { return fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e)).map(Number); }
  catch { return []; }
}

function linuxFind(port) {
  try {
    const inodes = linuxListeningInodes(port);
    if (!inodes.size) return null;
    for (const pid of allPids()) {
      let fds;
      try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch { continue; }
      for (const fd of fds) {
        let link;
        try { link = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); } catch { continue; }
        if (inodes.has(link)) return pid;
      }
    }
  } catch {}
  return null;
}

/** 兜底：/proc fd 扫描在异 pidns 环境（受限 /proc）看不到宿主进程时，用 ss（netlink，
 * 同 netns 可见宿主监听）解析 users:(…pid=NN…)——否则 findListeningPid 恒 null →
 * 误判失联重复拉起。ss 在安卓由 toybox 提供（/system/bin/ss），故候选含该路径。 */
function linuxFindSs(port) {
  const candidates = ['ss', '/system/bin/ss', '/usr/sbin/ss', '/usr/bin/ss', '/bin/ss'];
  for (const ssBin of candidates) {
    try {
      const out = ex.runOut(ssBin, ['-tlnHp', 'sport = :' + port], { timeoutMs: 3000 });
      const pid = parseSsPid(out);
      if (pid !== null) return pid;
    } catch {}
  }
  return null;
}

/** 找到监听 port 的进程 pid；找不到或环境不支持返回 null。 */
function findListeningPid(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  const a = linuxFind(port);
  if (a !== null && a !== undefined) return a;
  return linuxFindSs(port);
}

/** 进程存活检查（kill 0 信号探测）。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }
}

/** 读取进程命令行（/proc/<pid>/cmdline，NUL 分隔 → 空格）。 */
function readCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const buf = fs.readFileSync('/proc/' + pid + '/cmdline');
    return buf.toString('utf8').replace(/\0/g, ' ').trim();
  } catch { return null; }
}

/** 判断进程命令行是否匹配 DSH 特征。 */
function isDshCmdline(pid) {
  const cmd = readCmdline(pid);
  if (!cmd) return false;
  return /(^|\s)(node|.*dsh.*)(\s|$)/i.test(cmd) && /dsh/i.test(cmd);
}

/** 「按命令行模式匹配进程」：返回 [{pid, cmdline}]，pattern 按**子串**匹配。
 * 遍历 /proc 实现（安卓无 pgrep 的 -a/-f 差异问题，也不必引入外部二进制）。 */
function pgrepList(pattern) {
  const out = [];
  const pat = String(pattern);
  try {
    for (const pid of allPids()) {
      const cmd = readCmdline(pid);
      if (!cmd || !cmd.includes(pat)) continue;
      out.push({ pid, cmdline: cmd });
    }
  } catch {}
  return out;
}

/** 归一化 cmdline 的路径分隔符为 "/"。
 *
 * 为什么仍需要：本仓的进程**标记**（daemon-lifecycle 的 _cmdMarks、supervise-view/control-view
 * 的 "/domains/..." 字面量）按约定统一为 "/"，而某些来源（配置里的 Windows 路径、历史状态文件）
 * 可能带 "\"；比较前两侧都归一化，避免"认不出自己的 daemon"→ 误判端口异主 / 重复拉起。 */
function normCmdline(s) { return String(s || '').replace(/\\/g, '/'); }

module.exports = {
  findListeningPid, isAlive, readCmdline, normCmdline, isDshCmdline, pgrepList,
  // 输出纯解析器（生产代码直接调用，非平行实现）：使其可在任意宿主上穷举验证
  parseProcNetTcpInodes, parseSsPid,
};
