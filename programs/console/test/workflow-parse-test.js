#!/usr/bin/env node
'use strict';

// 工作流解析门禁（2026-09-11）。
//
// == 背景（真实 Windows CI 事故） ==
//
// Windows runner 的 git 检出会把 build.yml 转成 **CRLF**。测试里用 `\n` 锚定的正则
// （如 `/\n  ([a-z]+):\n/` 提取 YAML job 段）在 CRLF 下**完全失配** —— job 名后紧跟的是 `\r`。
// 于是 jobSection 返回空串 → 5 个断言失败；而 Linux/macOS（LF）全绿。
// 表现为「只在 Windows 红」，极难排查。
//
// 现状（2026-09-26 核对）：本仓 workflow 已无 Windows job，build.yml 也不在；
// 上述为历史事故记录。W1–W4 判据对现行 ci.yml 继续生效（其被测对象就是 ci.yml）。
//
// 本门禁确保不再回归：
//   W1 _workflow.normalize 对 CRLF / CR / LF 归一化结果一致
//   W2 jobSection 在 CRLF 下与 LF 下结果**完全相同**（用真实 ci.yml 实测）
//   W3 真实 ci.yml 在 CRLF 下仍能取到 console job 段（非空），
//      且安卓内核已删除的 PC 发布结构（precheck / build 矩阵 / launcher / npm 发布）
//      与第二个面板出口（program-release）都不得复活。
//   W4 任何测试不得用裸 fs.readFileSync 读 .github/workflows（必须经 _workflow.js）

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const W = require(path.join(__dirname, '_workflow.js'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

// ── W1 归一化 ──
console.log('== W1 行尾归一化 ==');
{
  const lf = 'a\nb\nc\n';
  const crlf = 'a\r\nb\r\nc\r\n';
  const cr = 'a\rb\rc\r';
  check('W1-a CRLF → LF', W.normalize(crlf) === lf, JSON.stringify(W.normalize(crlf)));
  check('W1-b CR → LF', W.normalize(cr) === lf, JSON.stringify(W.normalize(cr)));
  check('W1-c LF 不变', W.normalize(lf) === lf);
  check('W1-d 混合行尾归一', W.normalize('a\r\nb\nc\r') === lf);
}

// ── W2/W3 真实 ci.yml 在 CRLF 下解析一致 ──
console.log('== W2/W3 CRLF 下 jobSection 一致 ==');
{
  // 单仓 lobos-mobile：统一门禁住在仓库根的 .github/workflows/ci.yml
  // （旧内核独立仓的 build.yml 已并入其中），所以 root 要指到仓根而不是内核目录。
  const lf = W.readWorkflow('ci.yml', path.join(ROOT, '..', '..'));
  const crlf = lf.replace(/\n/g, '\r\n');   // 模拟 Windows 检出
  check('W2-a 确认构造成 CRLF', crlf.includes('\r\n'));

  // 统一门禁里内核的 job 只有一个：`console`（内核回归 + 前端门禁）。
  // 面板的投递口不在这份文件里：ADR-0011 之后唯一发布者是 `.github/workflows/program-ota.yml`，
  // 而「哪几条链能投递、各自的触发形状」已有宿主 `container/engine/test/release-trigger-test.js`，
  // 这里判第二遍就是给同一条判据养两个身体。
  const names = ['console'];
  let same = 0;
  for (const n of names) {
    const a = W.jobSection(lf, n);
    const b = W.jobSection(crlf, n);
    if (a === b) same += 1;
    else console.log('     差异 job=' + n + '  LF长度=' + a.length + '  CRLF长度=' + b.length);
  }
  check('W2-b 全部 job 段在 LF/CRLF 下一致', same === names.length, same + '/' + names.length);

  // W3：必须真的取到内容（这正是 CI 失败时的表现：取到空串）
  const consoleSection = W.jobSection(crlf, 'console');
  check('W3-a CRLF 下 console 段非空', consoleSection.length > 0, consoleSection.length + ' 字符');
  // 旧 `program-release`（第二个面板出口，发 lobos-console-panel-<ver>.tar.gz）已删，不得复活
  check('W3-b CRLF 下 ci.yml 里没有第二个面板发布者 job', W.jobSection(crlf, 'program-release').length === 0);

  // 安卓内核已删除的 PC 发布结构不得复活（单写入者 = 容器 OTA，内核不发布 npm / 不出 launcher）
  check('W3-c CRLF 下 precheck job 已删除（无发布前探活）', W.jobSection(crlf, 'precheck').length === 0);
  check('W3-d CRLF 下 console 用 ubuntu 且不用 matrix.os', /runs-on:\s*ubuntu/.test(consoleSection) && !/matrix\.os/.test(consoleSection));
  check('W3-e CRLF 下 console 跑安卓路径内核测试', /LOBOS_ANDROID/.test(consoleSection) && /npm test/.test(consoleSection));
  // 全量不变量：整个 workflow（注释已剥离）不得出现 matrix.os / npm 发布 / release 脚本 / xvfb
  const whole = W.stripComments(lf);
  check('W3-h 全 workflow 无 matrix.os / launcher / npm 发布 / release 脚本 / xvfb',
    !/matrix\.os/.test(whole) && !/npm\s+publish/.test(whole) && !/release\/scripts/.test(whole) && !/xvfb/i.test(whole));
}

// ── W4 禁止裸读 workflow ──
console.log('== W4 禁止裸读 .github/workflows ==');
{
  const files = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'workflow-parse-test.js');
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//')) return;
      // 直接 readFileSync 打开 workflows 下的文件 → 违规（缺行尾归一化）
      if (/readFileSync/.test(line) && /workflows/.test(line)) offenders.push(f + ':' + (i + 1));
    });
  }
  check('W4 无裸 fs.readFileSync 读 workflow', offenders.length === 0, offenders.join(', '));
}

// ── W5 引用仓内脚本的 job 必须自己检出仓库 ──
// 案底（2026-09-27 真踩）：release-admin 的 publish job 少一步 actions/checkout，
// 而它第 2 步就 `bash scripts/pick.sh …` → 退 127，整条手工发布链是坏的。
// 同文件的 repack / pin 都有 checkout，所以「别的口能跑」完全不能推出「这个口能跑」——
// 判据只能按 job 逐个取证，不能按文件计数。
const SCRIPT_USE = /(?:bash|sh|node|python3?|\.\/)\s*\S*scripts\/[\w.+-]+/;
const CHECKOUT = /uses:\s*actions\/checkout@/;
/** 纯判据：给定 `[[job 名, job 正文]]`，返回「用了仓内脚本但没检出仓库」的 job 名。 */
function checkoutGaps(entries) {
  return entries.filter(([, body]) => SCRIPT_USE.test(body) && !CHECKOUT.test(body)).map(([n]) => n);
}
console.log('== W5 用 scripts/ 的 job 必须有 checkout ==');
{
  // 判据自身先自证：负样本必被抓，正对照不许误伤（写坏了没人知道 = 空转闸）。
  const neg = checkoutGaps([['ghost', '\n      - run: bash scripts/pick.sh apk /tmp\n']]);
  check('W5-a 负样本被抓（用 scripts/ 无 checkout）', JSON.stringify(neg) === '["ghost"]', JSON.stringify(neg));
  const pos = checkoutGaps([['ok', '\n      - uses: actions/checkout@v4\n      - run: bash scripts/pick.sh apk /tmp\n']]);
  check('W5-b 正对照不误伤', pos.length === 0, JSON.stringify(pos));

  const root = path.join(ROOT, '..', '..');
  const dir = path.join(root, '.github', 'workflows');
  const gaps = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const entries = W.jobsOf(W.readWorkflow(f, root)).filter(([n]) => n !== 'on' && n !== 'workflow_dispatch' && n !== 'push');
    for (const j of checkoutGaps(entries)) gaps.push(f + '#' + j);
    // 切分本身也要自证：每个文件至少切出一个 job，否则「零违规」是空转出来的。
    if (entries.length === 0) gaps.push(f + '#（一个 job 都没切出来 → 切分正则失效）');
  }
  check('W5 全部 workflow 的每个 job：用 scripts/ 者必 checkout', gaps.length === 0, gaps.join(', '));
}

// ── W6 诊断输出的「step outcomes」清单不得两份漂移 ──
// 案底：build-apk.yml 曾把同一份清单**手写两遍**（正常路径 / 失败路径）。只改一份的后果是
// 失败诊断里看不到那个步骤，把它误判成"上一步失败"。
// 现状（2026-10-01 核对）：那份清单已整体不在 —— 失败诊断改成一个 `if: failure()` 的单一
// 落盘块（build-apk.yml:647 起），所以「两份一致」这个判据没有宿主可指了。判据留在这里
// 钉的是**形状**：这类手写清单出现多于一份时必须逐项一致；份数当作读数打出来，不当判据，
// 免得把「已经改成单份」误记成「门禁通过」。
/** 从 workflow 文本里取出所有「step outcomes」手写清单（每项 = 步骤 id 数组）。 */
function outcomeLists(src) {
  const lines = W.normalize(src).split('\n');
  const lists = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/step outcomes/.test(lines[i])) continue;
    const ids = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*(#|$)/.test(lines[j])) continue;
      const m = lines[j].match(/echo\s+"([a-z][a-z0-9-]*)\s*:\s*\$\{\{\s*steps\.[A-Za-z0-9_-]+/);
      if (!m) break;
      ids.push(m[1]);
    }
    lists.push(ids);
  }
  return lists;
}
/** 纯判据：多于一个清单时，返回与第 1 份不一致的那些清单序号。 */
function driftedLists(lists) {
  const bad = [];
  for (let i = 1; i < lists.length; i++) {
    if (JSON.stringify(lists[i]) !== JSON.stringify(lists[0])) bad.push(i + 1);
  }
  return bad;
}
console.log('== W6 step outcomes 清单多份必一致 ==');
{
  // 判据自证（双向）：先证明取清单与比对真的会红，再看现行文件。
  const two = 'x:\n  # step outcomes\n  - echo "build: ${{ steps.build.outcome }}"\n  - echo "sign: ${{ steps.sign.outcome }}"\n';
  const twoSame = outcomeLists(two + two);
  check('W6-a 夹具能切出两份非空清单', twoSame.length === 2 && twoSame.every((l) => l.length === 2),
    '份数=' + twoSame.length + ' 长度=' + twoSame.map((l) => l.length).join('/'));
  const driftNeg = driftedLists([['build', 'sign'], ['build']]);
  check('W6-b 负样本被抓（第二份少一项 → 判红）', driftNeg.length === 1, JSON.stringify(driftNeg));
  check('W6-c 正对照不误伤（两份逐项相同）', driftedLists(twoSame).length === 0, JSON.stringify(twoSame));
  check('W6-d 单份不算漂移', driftedLists([['build']]).length === 0);

  const src = W.readWorkflow('build-apk.yml', path.join(ROOT, '..', '..'));
  const lists = outcomeLists(src);
  const bad = driftedLists(lists);
  check('W6 现行 build-apk.yml 的手写清单一不多于 1 份，多份必逐项一致', bad.length === 0,
    '份数=' + lists.length + ' 长度=' + lists.map((l) => l.length).join('/') + ' 不一致的份=' + JSON.stringify(bad));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
