#!/usr/bin/env bash
#
# 读「APK 发布回执账本」里的最高 versionCode —— 版本门禁的**第二只眼睛**（判据不住这里）。
#
# 为什么要有它（2026-09-30 定罪，债表 DS-16）：参照物以前只有「线上归档族」这一条路，而这条路
#   **可以被删**。同日两个真读数：23:19Z 参照物=44，23:52Z 参照物=34 —— 中间 33 分钟线上少掉
#   6 个 `v<数字>` 归档 Release 与 `v1.1.12` 上的两颗资产（`git/ref/tags/v1.1.9|10|11` 回 200 而
#   `releases/tags/…` 回 404）。门照样绿（45>34），而它管的正是「不可逆的 versionCode 回退」：
#   参照物被删小 = 门自动变松，且绿得看不出松过。
#   账本住在**独立分支的只追加文件**里（scripts/append-apk-receipt.sh 写），删 Release 这个动作
#   碰不到它，于是「已发过的最高码」有一份不依赖线上归档的下界。
#
# 与 scripts/read-archived-shell-version.sh 的分工：那一处读「线上现在还剩什么」，这一处读
#   「我们记过什么」。两处都**只取数不判定** —— 取严（max）与「两源不一致怎么办」只住
#   scripts/verify-apk-version-gate.sh，写第二份比较就是缺陷（门禁法 §7 第 1 条）。
#
# 为什么不是复用 ci-ok 分支（DS-16 最初登记的设想，本轮实测判死）：ci-ok 的五处写者全部
#   `git push origin HEAD:ci-ok --force`，head 的父提交就是当时的 main —— 现读第一页 100 条
#   commit 全是 main 的历史，ci-ok.txt 里只有**最新一次**读数。那里没有「序列」可读，
#   照着它写门 = 又一个每次都比不到数的门。
#
# 用法: bash scripts/read-apk-receipts.sh <输出目录>
#   成功时在 <输出目录>/version.json 落下读到的最高码（键形状与仓内 version.json 的 shell.* 一致，
#   好让判据宿主只有一种输入；另带 source* 说明它是从账本第几行取回来的）
# 退出:
#   0  = 取到了（账本里至少有一行读得出的 shell 读数）
#   10 = 账本还没有（分支或文件不存在）—— 是「尚未记账」，不是「线上什么都没有」
#   2  = 看不清（gh 失败 / 文件在却一行读数都读不出 / 记录条数与读出的行数对不上）
set -euo pipefail

OUTDIR="${1:-}"
REPO="${GITHUB_REPOSITORY:-}"
REF="ci-receipts"
LOG="apk-receipts.log"

if [ -z "$OUTDIR" ]; then
  echo "[error] 用法: $0 <输出目录>" >&2
  exit 2
fi
if [ -z "$REPO" ]; then
  echo "::error title=读回执账本::环境里没有 GITHUB_REPOSITORY，gh 不知道去哪个仓取。" >&2
  exit 2
fi
mkdir -p "$OUTDIR"
ERR="$OUTDIR/.read-err"
RAW="$OUTDIR/.$LOG"

# 「不存在」与「取不到」分开判（与 scripts/read-release-asset.sh 同一条措辞表）：
#   把 gh 失败降成「账本还没有」，门禁就会拿更弱的参照物放行 —— 那是最危险的一侧被放行。
absent() { grep -qiE 'HTTP 404|Not Found|no ref found|does not exist|not found' "$1"; }

if ! gh api -H 'Accept: application/vnd.github.raw+json' \
     "repos/$REPO/contents/$LOG?ref=$REF" >"$RAW" 2>"$ERR"; then
  if absent "$ERR"; then
    echo "[read:receipts] 账本 $REF/$LOG 还不存在 —— 尚未记账（调用方不得据此判「线上没有发布过」）"
    exit 10
  fi
  cat "$ERR" >&2 || true
  echo "::error title=读回执账本::取 $REF/$LOG 失败，且原因不是「它不存在」—— 看不清已记的账就不许继续发布。" >&2
  exit 2
fi

node - "$RAW" "$OUTDIR/version.json" "$REF" "$LOG" <<'NODE'
const fs = require('node:fs');
const [src, dst, REF, LOG] = process.argv.slice(2);
const text = fs.readFileSync(src, 'utf8');
// 一条记录 = 一个 RECEIPT 标记行之后的那一段（写入口见 scripts/append-apk-receipt.sh）。
// 按记录切、在记录内取字段：若整篇扫一遍再回头看 chain/run，读数与出处会**串到下一条**
// —— 那副形状在 CI 日志里长得和真读数一模一样，只有溯源时才发现点名点错了人。
const records = text.split(/^RECEIPT\s*$/m).slice(1);
// shell 行的形状 = `<versionName>+<versionCode>`，与归档资产名里那份读数同形，好让两处取严可比。
const ROW = /^shell\s*:\s*([0-9][^\s+]*)\+([0-9]+)\s*$/m;
const field = (rec, key) => ((new RegExp('^' + key + '\\s*:\\s*(\\S+)', 'm').exec(rec) || [, ''])[1]);
let best = null, counted = 0;
for (const rec of records) {
  const s = ROW.exec(rec);
  if (!s) continue;
  const code = Number(s[2]);
  if (!Number.isInteger(code)) continue;
  counted++;
  if (!best || code > best.code) best = { name: s[1], code, chain: field(rec, 'chain'), run: field(rec, 'run') };
}
if (counted === 0) {
  console.error('::error title=读回执账本::' + REF + '/' + LOG + ' 取回了 ' + text.length +
    ' 字节、' + records.length + ' 条记录，却一行读得出的 shell 读数都没有。账本形状不认识就不判 ——'
    + ' 判「尚未起账」等于把被写坏的账本当成没发过。');
  process.exit(2);
}
if (records.length > counted) {
  console.error('::error title=读回执账本::账本里有 ' + records.length + ' 条记录，但只有 ' + counted +
    ' 条读得出 shell 读数 —— 无法排除缺的那几条正是最高的一版，判「看不清」。');
  process.exit(2);
}
fs.writeFileSync(dst, JSON.stringify({
  shell: { versionName: best.name, versionCode: best.code },
  source: 'ci-receipt-ledger', sourceRef: REF, sourceFile: LOG,
  sourceRows: counted, sourceChain: best.chain, sourceRun: best.run,
}, null, 2) + '\n');
console.log('[read:receipts] 账本 ' + counted + '/' + records.length + ' 条可读 → 最高 versionCode=' + best.code +
  '（' + best.name + '+' + best.code + '，链路=' + (best.chain || '?') + '，run=' + (best.run || '?') + '）');
NODE
