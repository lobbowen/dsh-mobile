#!/usr/bin/env bash
# attach-and-publish.sh —— 把"无 .git 的工作副本"安全接回远端并发布到分支。
#
# 用法：
#   scripts/attach-and-publish.sh <工作副本目录> [远端URL] [分支名]
# 例：
#   scripts/attach-and-publish.sh ~/work/dsh-mobile https://github.com/lobbowen/dsh-mobile.git chore/attach-working-tree
#
# 红线（本脚本强制）：不 init、不 force-push、必须先 dry-run。
set -euo pipefail

SRC="${1:?用法: $0 <工作副本目录> [远端URL] [分支名]}"
REMOTE="${2:-https://github.com/lobbowen/dsh-mobile.git}"
BRANCH="${3:-chore/attach-working-tree}"
WORK="$(mktemp -d)"

command -v git   >/dev/null || { echo "缺少 git"; exit 1; }
command -v rsync >/dev/null || { echo "缺少 rsync"; exit 1; }
[ -d "$SRC" ] || { echo "源目录不存在: $SRC"; exit 1; }
[ -d "$SRC/.git" ] && { echo "源目录已含 .git —— 请直接用 git fetch/pull，不要走本脚本"; exit 1; }

echo "==> 克隆远端到 $WORK"
git clone "$REMOTE" "$WORK/repo"
cd "$WORK/repo"
git checkout -b "$BRANCH"

echo "==> dry-run 差异（远端 <-> 本地树）；确认后再继续"
rsync -an --delete --exclude '.git/' "$SRC/" ./
read -r -p "差异已确认，覆盖工作树并提交？[y/N] " ans
[ "$ans" = y ] || { echo "已取消"; exit 0; }

rsync -a --delete --exclude '.git/' "$SRC/" ./

echo "==> git status"
git status --short

git add -A
if git diff --cached --quiet; then
  echo "无差异，无需提交"; exit 0
fi
git commit -m "chore(repo): attach working tree (pre-refactor baseline)"

echo "==> 推送分支（不是 main）"
git push -u origin "$BRANCH"

cat <<EOF

完成。下一步（人工）：
  1) 在 GitHub 开 PR: $BRANCH -> main
  2) 评审合并后打 tag:  git tag baseline-$(date +%Y%m%d) && git push origin baseline-$(date +%Y%m%d)
  3) 若渲染 OTA/发版，按 GIT-REPO-STANDARD §5/§6 用 container-v* / kernel-v* tag
EOF
