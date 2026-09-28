'use strict';

// Program 市场索引服务：实时聚合 npm + GitHub 上的 Program 扩展。
//
// 权威判定：包/仓库在其清单字段中声明 `<bundleField>.bundle` 才视为一个可安装
// Program 扩展。字段名/关键词/主题/社区清单都是**构造期可配置**的，面板不写死任何
// 单一生态的名称（载荷自持其命名空间）。
//
// 分类基于 keywords + 描述启发；来源标注 npm / github / community。
// 缓存到磁盘，TTL 刷新。

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const GH_API = 'https://api.github.com';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const INDEX_FILE = 'program-market-cache.json';

// 分类关键词启发（通用，不含任何单一载荷名）。
const CATEGORIES = {
  '官方生态': ['official', 'lobos'],
  '免费模型源': ['free-provider', 'free-vision', 'opus', 'codex', 'openrouter', 'provider', 'subscription', 'chatgpt', 'gemini', 'claude'],
  '工具增强': ['tool', 'bash', 'fs', 'edit', 'search', 'web', 'browser', 'vision', 'vision-proxy', 'computer-use', 'shell'],
  '记忆管理': ['memory', 'memo', 'context', 'mnemon', 'auto-memory', 'knowledge', 'memos'],
  '自动化': ['workflow', 'crew', 'auto', 'schedule', 'cron', 'agent-teams', 'multi-agent', 'orchestrat', 'iterate', 'loop'],
  '视觉图像': ['vision', 'image', 'diagram', 'excalidraw', 'skin', 'theme', 'wallpaper', 'pet', 'background'],
  '远程访问': ['remote', 'lan', 'mobile', 'access', 'pocket', 'desktop', 'bridge', 'tui'],
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
    const options = { headers: { 'User-Agent': 'lobos-panel-market', 'Accept': 'application/json' } };
    const req = mod.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects from ' + url));
        // 重定向目标必须校验协议：file:// 会让 http/https get 同步抛。
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

class ProgramMarket {
  constructor(opts) {
    opts = opts || {};
    this.cacheDir = opts.cacheDir || path.dirname(opts.stateFile || '');
    this.stateFile = opts.stateFile;
    this.ttl = opts.ttlMs || DEFAULT_TTL_MS;
    this.logger = opts.logger || console;
    this.registry = opts.registry || DEFAULT_REGISTRY;
    // Program 清单字段名与检索面（载荷生态自持，面板不写死）。
    this.bundleField = opts.bundleField || 'lobos';
    this.keywords = opts.keywords || ['lobos-program', 'lobos-plugin'];
    this.topics = opts.topics || ['lobos-program'];
    this.communityRepo = opts.communityRepo || null; // 形如 owner/repo（提供精选清单）
    this.officialRepo = opts.officialRepo || null;   // 官方本体仓库（不是可选扩展）
    this.indexFile = path.join(this.cacheDir, INDEX_FILE);
    this._cache = null;
    this._ts = 0;
    this._inFlight = null;
    this.buildBudgetMs = opts.buildBudgetMs || 240000;
    this._deadline = 0;
    this._truncatedSources = new Set();
    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      this._cache = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      this._ts = this._cache && this._cache.indexedAt ? this._cache.indexedAt : Date.now();
      return true;
    } catch { return false; }
  }

  saveToDisk() {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = this.indexFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2));
      fs.renameSync(tmp, this.indexFile);
    } catch (e) { this.logger.error && this.logger.error('market cache write fail ' + e.message); }
  }

  async getIndex(force = false) {
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
    this._deadline = Date.now() + this.buildBudgetMs;
    this._truncatedSources = new Set();
    try { return await this._buildIndexInner(start); }
    finally { this._deadline = 0; }
  }

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

    for (const p of plugins) {
      p.category = p.category || classify(p);
      p.stars = p.stars || 0;
    }
    plugins.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    const prev = this._cache;
    const truncated = this._truncatedSources || new Set();
    if (prev && prev.plugins && prev.plugins.length > 0 && truncated.size > 0) {
      const freshNames = new Set(plugins.map((pp) => pp.name));
      const kept = prev.plugins.filter((pp) => truncated.has(pp.source) && !freshNames.has(pp.name));
      for (const kp of kept) { if (!seen.has(kp.name)) { seen.add(kp.name); plugins.push(kp); } }
      if (kept.length) this.logger.warn && this.logger.warn('market: 源 ' + [...truncated].join('/') + ' 因预算截断，已与旧缓存合并（补回 ' + kept.length + ' 条）');
    }
    if (prev && prev.plugins && prev.plugins.length > 0 && plugins.length < prev.plugins.length * 0.5) {
      const freshSources = new Set(plugins.map((pp) => pp.source));
      const keepPrev = prev.plugins.filter((pp) => !freshSources.has(pp.source));
      for (const kp of keepPrev) { if (!seen.has(kp.name)) { seen.add(kp.name); plugins.push(kp); } }
      this.logger.warn && this.logger.warn('market index partial build: ' + plugins.length + ' (prev ' + prev.plugins.length + ') — 失败源已沿用旧缓存');
    }
    plugins.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    this._cache = { indexedAt: Date.now(), sources: { npm: npm.length, github: gh.length, community: community.length }, total: plugins.length, plugins };
    this._ts = Date.now();
    this.saveToDisk();
    this.logger.info && this.logger.info('market index built in ' + (Date.now() - start) + 'ms: ' + plugins.length + ' programs');
    return this._cache;
  }

  /** 判定一个包的清单是否声明了本生态的 bundle 字段。 */
  _hasBundle(meta) {
    const f = meta && meta[this.bundleField];
    return !!(f && typeof f === 'object' && f.bundle);
  }

  /** npm 源：按配置的关键词检索，逐个校验 bundle 字段。 */
  async indexNpm() {
    const out = [];
    const allNames = new Set();
    for (const query of this.keywords) {
      try {
        for (let from = 0; from < 1000; from += 250) {
          const base = await this._npmOrigin();
          const url = base + '/-/v1/search?text=' + encodeURIComponent('keywords:' + query) + '&size=250&from=' + from;
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
    const batch = 8;
    for (let i = 0; i < names.length; i += batch) {
      if (this._budgetExhausted()) { this._truncatedSources.add('npm'); break; }
      const slice = names.slice(i, i + batch);
      await Promise.all(slice.map(async (name) => {
        const meta = await this.safeFetchLatest(name);
        if (this._hasBundle(meta)) {
          out.push({
            name,
            version: meta.version,
            description: (meta.description || '').slice(0, 200),
            author: pickAuthor(meta),
            homepage: meta.homepage || null,
            repository: (meta.repository && meta.repository.url) || null,
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

  async _npmOrigin() {
    let origin = null;
    if (this.dist) { try { origin = await this.dist.selectRegistry(false); } catch {} }
    return (origin || this.registry).replace(/\/+$/, '');
  }

  async safeFetchLatest(name) {
    try {
      const base = await this._npmOrigin();
      return await getJson(base + '/' + encodeURIComponent(name) + '/latest', 8000);
    } catch { return null; }
  }

  /** GitHub 源：按配置的 topic 检索，验证 bundle 字段。 */
  async indexGithub() {
    const out = [];
    const seen = new Set();
    for (const topic of this.topics) {
      try {
        const url = GH_API + '/search/repositories?q=topic:' + encodeURIComponent(topic) + '&sort=stars&order=desc&per_page=30';
        const d = await getJson(url, 12000);
        for (const r of (d.items || [])) {
          if (seen.has(r.full_name)) continue;
          seen.add(r.full_name);
          if (this.officialRepo && r.full_name === this.officialRepo) continue;
          const meta = await this.safeRepoPkg(r.full_name);
          if (this._hasBundle(meta)) {
            out.push({
              name: meta.name || r.name,
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

  async safeRepoPkg(fullName) {
    for (const branch of ['master', 'main']) {
      try { return await rawGet(fullName + '/' + branch + '/package.json', true, 8000); } catch {}
    }
    return null;
  }

  /** 社区精选清单（仅当构造期提供 communityRepo 时启用）。 */
  async indexCommunity() {
    const out = [];
    if (!this.communityRepo) return out;
    try {
      const md = await rawGet(this.communityRepo + '/main/README.md', false, 30000);
      const re = /\[([^\]|]+)\]\(https:\/\/(?:www\.)?(?:npmjs\.com\/package\/([\w@\/.-]+)|github\.com\/([\w.-]+\/[\w.-]+))\)/g;
      const links = [];
      let m;
      while ((m = re.exec(md)) !== null) { links.push({ npmName: m[2], ghName: m[3], label: m[1] || '' }); }
      const seenName = new Set();
      for (let i = 0; i < links.length; i += 8) {
        if (this._budgetExhausted()) { this._truncatedSources.add('community'); break; }
        const slice = links.slice(i, i + 8);
        await Promise.all(slice.map(async ({ npmName, ghName, label }) => {
          try {
            if (npmName) {
              const meta = await this.safeFetchLatest(npmName);
              if (this._hasBundle(meta) && !seenName.has(npmName)) {
                seenName.add(npmName);
                out.push({ name: npmName, version: meta.version || null, description: (meta.description || label || '').slice(0, 200), author: pickAuthor(meta), homepage: meta.homepage || null, repository: (meta.repository && meta.repository.url) || null, keywords: meta.keywords || [], stars: 0, source: 'community', hasBundle: true });
              }
            } else if (ghName) {
              const meta = await this.safeRepoPkg(ghName);
              if (this._hasBundle(meta) && !seenName.has(ghName)) {
                seenName.add(ghName);
                out.push({ name: meta.name || ghName, version: meta.version || null, description: (meta.description || label || '').slice(0, 200), author: ghName.split('/')[0], homepage: null, repository: 'https://github.com/' + ghName, keywords: meta.keywords || [], stars: 0, source: 'community', hasBundle: true });
              }
            }
          } catch { /* 单条失败跳过 */ }
        }));
      }
    } catch (e) { this.logger.error && this.logger.error('community index fail: ' + e.message); }
    return out;
  }
}

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
    const options = { headers: { 'User-Agent': 'lobos-panel-market' } };
    const req = mod.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects from ' + url));
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
      const MAX_BYTES = 2 * 1024 * 1024;
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

module.exports = { ProgramMarket };

