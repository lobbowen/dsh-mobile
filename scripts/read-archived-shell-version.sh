#!/usr/bin/env bash
#
# 读「日常链归档族里已经发到的最高 versionCode」——**日常链版本门禁的参照物**的唯一取数宿主。
#
# 为什么要有它（2026-09-30 定罪，③）：`fast-apk`（每次合并到 main 自动出包）把参照物写成
#   `apk-latest`，而**日常链按政策从不写 apk-latest**（滚动别名只由发布面 build-apk / release-admin 维护）。
#   线上现读（本仓 releases 列表端点，39 个 Release）：根本没有名为 apk-latest 的
#   Release，14 个 `v<versionName>` 归档 Release 里带 version.json 资产的 **0 个**。于是每次取数都退 10
#   （「按首次发布处理」），而调用方又恒传 `explicit`（首次发布在显式通道放行）⇒ 这道门从立起到今天
#   **一个数都没比过**，而它管的正是「不可逆的 versionCode 回退」。参照物空转的门比没有门更危险：
#   全绿读数会让人以为这一格有人守着。
#
#   日常链真正会写的只有 `v<versionName>` 这一族的**资产名**（`app-debug-<versionName>+<versionCode>.apk`，
#   见 fast-apk 自己的 VAPK/VTAG 那两行），所以参照物事实源就是这张归档名表 —— 不是新发明一条通道，
#   是把已经落在线上的那份读数取回来。
#
# 与 scripts/read-release-asset.sh 的分工：那一处判「某个 Release 上某个资产：不存在 vs 取不到」，
#   这一处**不重复那份分类**（这里没有「资产不存在」这一态：整族为空才是首次发布），
#   只保留同一条三态纪律：任何 gh 失败一律 2（看不清），绝不降成「线上什么都没有」。
#
# 用法: bash scripts/read-archived-shell-version.sh <输出目录>
#   成功时在 <输出目录>/version.json 落下读到的最高归档读数（形状与仓内 version.json 的
#   shell.versionCode 同键，好让判据宿主只有一种输入形状；另带 source* 三格说明它是**从资产名读出来的**）
# 退出:
#   0  = 取到了（有至少一颗带 versionCode 的归档 APK）
#   10 = 一个 `v<数字>` 归档 Release 都没有 —— 首次发布，是合法状态
#   2  = 看不清（gh 失败 / 返回形状不认识 / 单页被截断 / 族里有读不出码的 Release）
set -euo pipefail

OUTDIR="${1:-}"
REPO="${GITHUB_REPOSITORY:-}"

if [ -z "$OUTDIR" ]; then
  echo "[error] 用法: $0 <输出目录>" >&2
  exit 2
fi
if [ -z "$REPO" ]; then
  echo "::error title=读归档版本::环境里没有 GITHUB_REPOSITORY，gh 不知道去哪个仓取。" >&2
  exit 2
fi
mkdir -p "$OUTDIR"
ERR="$OUTDIR/.read-err"
JSON="$OUTDIR/.releases.json"

# 一次取一页。**满页即看不清**：静默截断会漏掉更高的归档，而漏掉参照物的门禁表现为「一切正常」。
# 现在线上 39 个 Release；真到满页那天这条会红并说出原因，那时才需要翻页 —— 不许提前把兜底写成默认。
if ! gh api "repos/$REPO/releases?per_page=100" >"$JSON" 2>"$ERR"; then
  cat "$ERR" >&2 || true
  echo "::error title=读归档版本::取 repos/$REPO/releases 失败，原因不是「线上没有归档」—— 看不清线上是什么就不许继续发布。" >&2
  exit 2
fi

node - "$JSON" "$OUTDIR/version.json" <<'NODE'
const fs = require('node:fs');
const [src, dst] = process.argv.slice(2);
let rel;
try { rel = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) {
  console.error('::error title=读归档版本::releases 返回体不是可读 JSON: ' + e.message); process.exit(2);
}
if (!Array.isArray(rel)) {
  console.error('::error title=读归档版本::releases 返回的不是数组（' + typeof rel + '），形状不认识就不判。');
  process.exit(2);
}
if (rel.length >= 100) {
  console.error('::error title=读归档版本::一页正好取满 100 条 —— 后面还有 Release 没读，最高归档可能更高。' +
    '这一步需要翻页（本宿主刻意先不做，等它真红再做，别把兜底当默认）。');
  process.exit(2);
}
// 归档族 = tag 形如 `v<数字>…`（fast-apk 写的是 `v$VN`）。资产名里的 `<versionName>+<versionCode>`
//   就是日常链钉死在产物名上的那份读数（见 fast-apk 的 VAPK）。
const ASSET = /-(\d[^+]*?)\+([0-9]+)\.apk$/;
const ARCHIVE_TAG = /^v\d/;
const archives = rel.filter((r) => r && typeof r.tag_name === 'string' && ARCHIVE_TAG.test(r.tag_name));
if (!archives.length) {
  console.log('[read:archive] 线上没有任何 v<数字> 归档 Release —— 按首次发布处理');
  process.exit(10);
}
// 返回顺序按创建时间倒序（新的在前），所以同一颗最高码取**最近**那次发布的名字。
let best = null;
for (const r of archives) {
  const assets = Array.isArray(r.assets) ? r.assets : [];
  let matched = 0;
  for (const a of assets) {
    const m = ASSET.exec(String(a && a.name || ''));
    if (!m) continue;
    matched++;
    const vc = Number(m[2]);
    if (!best || vc > best.code) best = { tag: r.tag_name, asset: a.name, name: m[1], code: vc };
  }
  if (assets.length > 0 && matched === 0) {
    console.error('::error title=读归档版本::归档 ' + r.tag_name + ' 里的资产名读不出 versionCode（[' +
      assets.map((a) => a && a.name).join(', ') + ']）—— 无法排除它就是最高的一版，看不清即不许发布。' +
      '修法是让这一族的资产名回到 <versionName>+<versionCode>.apk，或给它补 version.json 资产。');
    process.exit(2);
  }
}
if (!best) {
  console.error('::error title=读归档版本::' + archives.length + ' 个 v<数字> 归档里一颗带 versionCode 的 APK 资产都没读到，' +
    '参照物无从确定 —— 判「看不清」，不判「首次发布」。');
  process.exit(2);
}
fs.writeFileSync(dst, JSON.stringify({
  shell: { versionName: best.name, versionCode: best.code },
  source: 'archive-asset-name', sourceTag: best.tag, sourceAsset: best.asset,
}, null, 2) + '\n');
console.log('[read:archive] 最高归档 ' + best.tag + ' / ' + best.asset + ' → versionCode=' + best.code);
NODE
