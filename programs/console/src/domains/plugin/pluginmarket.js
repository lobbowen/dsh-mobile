'use strict';

// 插件市场索引服务：实时聚合 npm + GitHub 的 DeepSeek Harness 插件。
// 权威判定：包/仓库声明 dsh.bundle 才视为 DSH 插件。
// 分类基于 keywords + 描述启发；来源标注 npm / github / community。
// 缓存到磁盘，TTL 刷新，保证"一直最新"。

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY = 'https://registry.npmjs.org';
const GH_API = 'https://api.github.com';
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟
const INDEX_FILE = 'plugin-market-cache.json';

// 分类关键词启发
const CATEGORIES = {
  '官方生态': ['@deepseek-ai', 'deepseek-harness官方', 'official'],
  '免费模型源': ['free-provider', 'free-vision', 'opus', 'codex', 'openrouter', 'provider', 'subscription', 'chatgpt', 'gemini', 'claude'],
  '工具增强': ['tool', 'bash', 'fs', 'edit', 'search', 'web', 'browser', 'vision', 'vision-proxy', 'computer-use', 'shell'],
  '记忆管理': ['memory', 'memo', 'context', 'mnemon', 'auto-memory', 'knowledge', 'memos'],
  '自动化': ['workflow', 'crew', 'auto', 'schedule', 'cron', 'agent-teams', 'multi-agent', 'orchestrat', 'iterate', 'loop'],
  '视觉图像': ['vision', 'image', 'diagram', 'excalidraw', 'skin', 'theme', 'wallpaper', 'pet', 'background'],
  '远程访问': ['remote', 'lan', 'mobile', 'access', 'pocket', 'desktop', 'bridge', 'tui', 'pi'],
  '聊天集成': ['feishu', 'lark', 'wechat', 'wecom', 'im', 'bot', 'qq', 'telegram'],
  '数据管理': ['usage', 'cost', 'account', 'wallet', 'stat', 'quota', 'token', 'billing'],
  '其他': [],
};

function classify(pkg) {
  const text = (pkg.name + ' ' + (pkg.description || '') + ' ' + (pkg.keywords || []).join(' ')).toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORIES)) {
    if (cat === '其他') continue;
    for (const kw of kws) {
      if (text.includes(kw.toLowerCase())) return cat;
    }
  }
  return '其他';
}

// 简易 JSON GET（加固：响应体上限 5MB / 非 2xx 直接失败 / 重定向最多 5 跳）
function getJson(url, timeoutMs = 10000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = { headers: { 'User-Agent': 'dsh-supervisor-market', 'Accept': 'application/json' } };
    const req = mod.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects from ' + url));
        // P1-3 修复（2026-09-12）：重定向目标**必须校验协议**。
        // 缺陷：直接把 `res.headers.location` 递归传回；若它是 `file://…`，
        // `mod.get()`（http/https 模块）会**同步抛 ERR_INVALID_PROTOCOL**，
        // 而此处位于响应回调内 → 逃逸为进程级 uncaughtException。
        // 触发面：registry 可配任意 https（仅校验 ^https?://），或其 302 可达第三方镜像。
        const next = String(res.headers.location);
        if (!/^https?:\/\//i.test(next)) return reject(new Error('重定向到不支持的协议: ' + next.slice(0, 64)));

        return getJson(next, timeoutMs, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
      }
      let b = '';
      let over = false;
      const MAX_BYTES = 5 * 1024 * 1024;
      res.on('data', (c) => {
        if (over) return;
        b += c;
        if (b.length > MAX_BYTES) { over = true; b = ''; try { req.destroy(); } catch {} reject(new Error('response too large from ' + url)); }
      });
      res.on('end', () => {
        if (over) return;
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json from ' + url)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
    req.on('error', reject);
    req.setTimeout(timeoutMs);
  });
}

class PluginMarket {
  constructor(opts) {
    this.cacheDir = opts.cacheDir || path.dirname(opts.stateFile || '');
    this.stateFile = opts.stateFile;
    this.ttl = opts.ttlMs || DEFAULT_TTL_MS;
    this.logger = opts.logger || console;
    this.dist = opts.dist || null;   // 安装/分发系统：镜像源选择收口处（npm 版本查询走镜像，不再硬编码官方源）
    this.indexFile = path.join(this.cacheDir, INDEX_FILE);
    this._cache = null;
    this._ts = 0;
    this._inFlight = null;
    // P2-8 修复（2026-09-12）：**整体构建预算**（防一次刷新挂住请求数十分钟）。
    // 背景：社区源候选约 2468 个，按 8 并发分批、每批各带超时 —— 最坏情况可达数十分钟，
    // 而 `GET /plugins/market` 会**阻塞到构建完成**（前端 15s 就放弃了，服务端却还在跑）。
    // 现给整次构建一个上限：到点则**停止发起新批次**，用已采集的部分构建索引；
    // 与既有的「坏构建保护」天然配合（部分结果不会冲掉旧缓存）。
    this.buildBudgetMs = opts.buildBudgetMs || 240000; // 默认 4 分钟
    this._deadline = 0;
    // P2-8 配套：本次构建被**预算截断**的源（部分结果不得替换完整缓存，见 _buildIndexInner）。
    this._truncatedSources = new Set();
    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      this._cache = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      // 2026-09 修复：_ts 用缓存真实 indexedAt（曾重置为 Date.now() → TTL 永不触发 → 永不自动刷新）
      this._ts = this._cache && this._cache.indexedAt ? this._cache.indexedAt : Date.now();
      return true;
    } catch { return false; }
  }

  saveToDisk() {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = this.indexFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2)); fs.renameSync(tmp, this.indexFile); // 原子写
    } catch (e) { this.logger.error && this.logger.error('market cache write fail ' + e.message); }
  }

  /** 读取插件列表（带 TTL 缓存 + 并发去重）。 */
  async getIndex(force = false) {
    // 有缓存（含磁盘加载）直接返回；后台刷新
    if (this._cache && !force) {
      this._refreshIfStale(force);
      return this._cache;
    }
    if (this._inFlight) return this._inFlight;
    this._inFlight = this.buildIndex().finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  _refreshIfStale() {
    if (Date.now() - this._ts < this.ttl) return;
    if (this._inFlight) return;
    this._inFlight = this.buildIndex().finally(() => { this._inFlight = null; });
  }

  async buildIndex() {
    const start = Date.now();
    // P2-8：整次构建的总预算（到点停止发起新批次，返回已采集的部分）。
    this._deadline = Date.now() + this.buildBudgetMs;
    this._truncatedSources = new Set();
    try { return await this._buildIndexInner(start); }
    finally { this._deadline = 0; }
  }

  /** 预算是否已耗尽（供各源的批次循环调用）。 */
  _budgetExhausted() { return this._deadline > 0 && Date.now() >= this._deadline; }

  async _buildIndexInner(start) {
    const plugins = [];
    const seen = new Set();
    const add = (p) => {
      if (!p || seen.has(p.name)) return;
      seen.add(p.name);
      plugins.push(p);
    };

    const npm = await this.indexNpm();
    npm.forEach(add);

    const gh = await this.indexGithub();
    gh.forEach(add);

    const community = await this.indexCommunity();
    community.forEach(add);

    // 分类 + 排序（按 stars/流行度）
    for (const p of plugins) {
      p.category = p.category || classify(p);
      p.stars = p.stars || 0;
    }
    plugins.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    const prev = this._cache;

    // ── 保护 A：**预算截断的源**必须与旧缓存取并集（P2-8 配套修复，2026-09-12）──
    //
    // 为什么必须单独处理：下面的保护 B 判据是 `!freshSources.has(source)`
    // ——「本次**整个源失败**」。而被预算截断的源**仍然出现在结果里**（只是不完整），
    // 于是保护 B **不会**保留它的旧条目：只跑到 200/2400 的 community 源
    // 会**替换掉**缓存的完整 community 列表，市场瞬间缩水且只留一条 warn。
    // （这是我加整体预算时引入的回归：「截断」与「整源失败」语义不同，不能共用判据。）
    //
    // 截断源的并集**不受 50% 比例约束** ——「不完整」本身就是需要合并的充分理由。
    const truncated = this._truncatedSources || new Set();
    if (prev && prev.plugins && prev.plugins.length > 0 && truncated.size > 0) {
      const freshNames = new Set(plugins.map((pp) => pp.name));
      const kept = prev.plugins.filter((pp) => truncated.has(pp.source) && !freshNames.has(pp.name));
      for (const kp of kept) { if (!seen.has(kp.name)) { seen.add(kp.name); plugins.push(kp); } }
      if (kept.length) {
        this.logger.warn && this.logger.warn(
          'market: 源 ' + [...truncated].join('/') + ' 因预算截断，已与旧缓存合并（补回 ' + kept.length + ' 条）'
        );
      }
    }

    // ── 保护 B（既有，2026-09）：本次结果比上次缓存显著缩水（<50%）→ 某源大面积失败（网络/限流），
    // 沿用旧缓存中本次**完全缺失**的源；绝不因一次坏构建丢掉好缓存。
    if (prev && prev.plugins && prev.plugins.length > 0 && plugins.length < prev.plugins.length * 0.5) {
      const freshSources = new Set(plugins.map((pp) => pp.source));
      const prevByKey = new Map(prev.plugins.map((pp) => [pp.name, pp]));
      const keepPrev = prev.plugins.filter((pp) => !freshSources.has(pp.source)); // 本次整个源失败 → 沿用旧源全部
      for (const kp of keepPrev) { if (!seen.has(kp.name)) { seen.add(kp.name); plugins.push(kp); } }
      this.logger.warn && this.logger.warn('market index partial build: ' + plugins.length + ' (prev ' + prev.plugins.length + ') — 失败源已沿用旧缓存');
    }

    // 合并进来的旧条目未参与上面的排序 → 重排一次，保持 stars 降序（前端依赖该序）。
    plugins.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    this._cache = { indexedAt: Date.now(), sources: { npm: npm.length, github: gh.length, community: community.length }, total: plugins.length, plugins };
    this._ts = Date.now();
    this.saveToDisk();
    this.logger.info && this.logger.info('market index built in ' + (Date.now() - start) + 'ms: ' + plugins.length + ' plugins (npm=' + npm.length + ', gh=' + gh.length + ', community=' + community.length + ')');
    return this._cache;
  }

  /** npm 源：搜 deepseek-harness 受限 dsh，逐个检测 dsh.bundle。 */
  async indexNpm() {
    const out = [];
    const queries = ['keywords:deepseek-harness', 'keywords:dsh-bundle', 'keywords:dsh-plugin'];
    const allNames = new Set();
    for (const query of queries) {
      try {
        // 分页拉取所有候选（每页 250，最多 1000）
        for (let from = 0; from < 1000; from += 250) {
          const base = await this._npmOrigin();
          const url = base + '/-/v1/search?text=' + encodeURIComponent(query) + '&size=250&from=' + from;
          let d;
          try { d = await getJson(url, 15000); } catch { break; }
          const items = d.objects || [];
          for (const o of items) allNames.add(o.package.name);
          if (items.length < 250) break;
        }
      } catch (e) { this.logger.error && this.logger.error('npm search fail ' + query + ': ' + e.message); }
    }
    const names = [...allNames];
    this.logger.info && this.logger.info('npm candidates: ' + names.length);
    // 并行验证 dsh.bundle
    const batch = 8;
    for (let i = 0; i < names.length; i += batch) {
      // P2-8：预算耗尽即停止发起新批次（已采集的部分照常返回）。
      if (this._budgetExhausted()) { this._truncatedSources.add("npm"); this.logger.warn && this.logger.warn("market: npm 源预算耗尽，已处理 " + i + "/" + names.length + " 个候选"); break; }
      const slice = names.slice(i, i + batch);
      await Promise.all(slice.map(async (name) => {
        const meta = await this.safeFetchLatest(name);
        if (meta && meta.dsh && meta.dsh.bundle) {
          out.push({
            name,
            version: meta.version,
            description: (meta.description || '').slice(0, 200),
            author: pickAuthor(meta),
            homepage: meta.homepage || null,
            repository: meta.repository && meta.repository.url || null,
            keywords: meta.keywords || [],
            stars: 0,
            source: 'npm',
            hasBundle: true,
          });
        }
      }));
    }
    return out;
  }
  /** npm 镜像源 origin（经 dist 统一选择；dist 不可达降级官方源）。 */
  async _npmOrigin() {
    let origin = null;
    if (this.dist) { try { origin = await this.dist.selectRegistry(false); } catch {} }
    return (origin || REGISTRY).replace(/\/+$/, '');
  }

  /** npm 最新版元数据查询：走 dist 统一镜像源（国内可达性/手动固定与全系统一致）。 */
  async safeFetchLatest(name) {
    try {
      const base = await this._npmOrigin();
      const d = await getJson(base + '/' + encodeURIComponent(name) + '/latest', 8000);
      return d;
    } catch { return null; }
  }

  /** GitHub 源：搜 topic:dsh-plugin + deepseek-harness，逐个验证 dsh.bundle。 */
  async indexGithub() {
    const out = [];
    const topics = ['dsh-plugin', 'deepseek-harness'];
    const seen = new Set();
    for (const topic of topics) {
      try {
        const url = GH_API + '/search/repositories?q=topic:' + topic + '&sort=stars&order=desc&per_page=30';
        const d = await getJson(url, 12000);
        for (const r of (d.items || [])) {
          if (seen.has(r.full_name)) continue;
          seen.add(r.full_name);
          const text = (r.full_name + ' ' + (r.description || '')).toLowerCase();
          if (!text.includes('dsh') && !text.includes('deepseek-harness') && !text.includes('deepseek harness')) continue;
          // 略过官方本体仓库（不是可选插件）
          if (r.full_name === 'deepseek-ai/deepseek-harness') continue;
          const meta = await this.safeRepoPkg(r.full_name);
          if (meta && meta.dsh && meta.dsh.bundle) {
            const pkgName = meta.name || r.name;
            out.push({
              name: pkgName,
              version: meta.version || null,
              description: (meta.description || r.description || '').slice(0, 200),
              author: (r.owner && r.owner.login) || null,
              homepage: r.homepage || null,
              repository: r.html_url || null,
              keywords: meta.keywords || [],
              stars: r.stargazers_count || 0,
              source: 'github',
              hasBundle: true,
            });
          }
        }
      } catch (e) { this.logger.error && this.logger.error('github index fail ' + topic + ': ' + e.message); }
    }
    return out;
  }

  /** 抓取 GitHub 仓库 package.json（raw）验证 dsh.bundle。 */
  async safeRepoPkg(fullName) {
    for (const branch of ['master', 'main']) {
      try { return await rawGet(fullName + '/' + branch + '/package.json', true, 8000); } catch {}
    }
    return null;
  }

  /** 社区列表：抓 awesome-dsh-plugin README 白名单（官方社区维护的精选）。 */
  async indexCommunity() {
    const out = [];
    try {
      const md = await rawGet('awesome-dsh-plugin/awesome-dsh-plugin/main/README.md', false, 30000);
      // 提取 npm 包名（- 或 [` 开头的 包名）+ GitHub 全名
      const re = /\[([^\]|]+)\]\(https:\/\/(?:www\.)?(?:npmjs\.com\/package\/([\w@\/.-]+)|github\.com\/([\w.-]+\/[\w.-]+))\)/g;
      const links = [];
      let m;
      while ((m = re.exec(md)) !== null) { links.push({ npmName: m[2], ghName: m[3], label: m[1] || '' }); }
      // 2026-09 提速：候选（~2468）串行逐个打 npm 太慢/易整体超时 → 并发批次（8），单条失败安全跳过
      const seenName = new Set();
      for (let i = 0; i < links.length; i += 8) {
        // P2-8：预算耗尽即停止（社区源候选最多，是最容易超时的一段）。
        if (this._budgetExhausted()) { this._truncatedSources.add("community"); this.logger.warn && this.logger.warn("market: community 源预算耗尽，已处理 " + i + "/" + links.length + " 个候选"); break; }
        const slice = links.slice(i, i + 8);
        await Promise.all(slice.map(async ({ npmName, ghName, label }) => {
          try {
            if (npmName) {
              const meta = await this.safeFetchLatest(npmName);
              if (meta && meta.dsh && meta.dsh.bundle && !seenName.has(npmName)) {
                seenName.add(npmName);
                out.push({ name: npmName, version: meta.version || null, description: (meta.description || label || '').slice(0, 200), author: pickAuthor(meta), homepage: meta.homepage || null, repository: meta.repository && meta.repository.url || null, keywords: meta.keywords || [], stars: 0, source: 'community', hasBundle: true });
              }
            } else if (ghName) {
              const meta = await this.safeRepoPkg(ghName);
              if (meta && meta.dsh && meta.dsh.bundle && !seenName.has(ghName)) {
                seenName.add(ghName);
                out.push({ name: meta.name || ghName, version: meta.version || null, description: (meta.description || label || '').slice(0, 200), author: ghName.split('/')[0], homepage: null, repository: 'https://github.com/' + ghName, keywords: meta.keywords || [], stars: 0, source: 'community', hasBundle: true });
              }
            }
          } catch { /* 单条失败跳过，不影响整体 */ }
        }));
      }
    } catch (e) { this.logger.error && this.logger.error('community index fail: ' + e.message); }
    return out;
  }
}

/** raw.githubusercontent.com 镜像回退（2026-09 修复：该域名在部分网络不可达 → github/community
 * 源整源失败致插件数大幅缩水）。先直连 raw，失败/超时走 gh-proxy.com 镜像（URL 前缀包装）。 */
const RAW_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/'];
async function rawGet(pathPart, isJson, timeoutMs = 15000) {
  const direct = 'https://raw.githubusercontent.com/' + pathPart;
  const tryOne = (url) => isJson
    ? getJson(url, timeoutMs).then((d) => ({ ok: true, data: d }), () => ({ ok: false }))
    : getText(url, timeoutMs).then((d) => ({ ok: true, data: d }), () => ({ ok: false }));
  let r = await tryOne(direct);
  if (r.ok) return r.data;
  for (const mir of RAW_MIRRORS) {
    r = await tryOne(mir + direct);
    if (r.ok) return r.data;
  }
  throw new Error('raw fetch failed for ' + pathPart);
}

function getText(url, timeoutMs = 8000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = { headers: { 'User-Agent': 'dsh-supervisor-market' } };
    const req = mod.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects from ' + url));
        // P1-3：同上 —— 重定向目标必须校验协议（file:// 会让 http.get 同步抛）。
        const next = String(res.headers.location);
        if (!/^https?:\/\//i.test(next)) return reject(new Error('重定向到不支持的协议: ' + next.slice(0, 64)));
        return getText(next, timeoutMs, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
      }
      let b = '';
      let over = false;
      const MAX_BYTES = 2 * 1024 * 1024; // 社区 README 远小于 2MB；防无界缓冲
      res.on('data', (c) => {
        if (over) return;
        b += c;
        if (b.length > MAX_BYTES) { over = true; b = ''; try { req.destroy(); } catch {} reject(new Error('response too large from ' + url)); }
      });
      res.on('end', () => { if (!over) resolve(b); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.setTimeout(timeoutMs);
  });
}

function pickAuthor(meta) {
  const a = meta.author;
  if (!a) return null;
  if (typeof a === 'string') return a;
  return a.name || null;
}

module.exports = { PluginMarket };
