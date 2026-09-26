#!/usr/bin/env bash
# ============================================================================
#  Release 资产覆盖上传 —— 「把产物投到设备真正去读的那个 tag」这一步的唯一实现。
#
#  为什么要有这个宿主：同一条「确保 Release 在 → 覆盖上传 → 事后看一眼」此前在
#  fast-apk / build-apk / release-admin(publish) / release-admin(repack) /
#  kernel-ota(滚动通道) 各写了一份，严格程度还不一样 —— 有的带「孤立资产回退」，
#  有的只 clobber，有的先删后传。副本多到这份上，实际代价不是重复而是分歧：
#  repack 那份把 `/tmp/app-signed.apk#app-debug.apk` 当改名用，而 gh 的资产名
#  **取 file 的 basename**、`#` 后面只是 label（这条事实记录在 fast-apk.yml
#  「覆盖上传」注释块），于是它删掉了 app-debug.apk、传上去的是 app-signed.apk ——
#  稳定下载地址 404，已装设备读不到更新；没有任何一份副本会自查这件事。
#
#  本宿主把三件事收成一件事，并且**上传后必须回读确认**：资产名与字节数都对得上
#  才算发布发生。上传命令返回 0 不等于线上真有了（孤立资产/后端 404 的前科见
#  fast-apk.yml 里 2026-09-23 的记录）。
#
#  退出码（与 scripts/read-release-asset.sh 同一套三档语义）：
#    退 0   = 每个文件都已在该 tag 上、字节数一致
#    退 1   = 任一步不成：线上状态读不清 / 创建失败 / 覆盖失败 / 事后确认不过
#    退 2   = 用法错（参数不齐、文件不在、既给 --notes 又给 --notes-file）
#
#  用法：
#    bash scripts/gh-release-upload.sh <release tag> [选项] <文件>…
#      --title <文本>        Release 不存在时用它创建（不给则用 tag 本身）
#      --notes <文本>        创建说明；与 --notes-file 互斥
#      --notes-file <路径>   创建说明取自文件（kernel-ota 用的是渲染出来的 notes.md）
#      --prune <正则>        上传后删掉该 tag 上名字匹配此正则、且不属于本次/--keep 的
#                            资产 —— 滚动通道只该留「本次」那份，否则随发布无限堆积
#      --keep <名称>         配合 --prune，可重复；本次刚传的资产名自动列入
#      --skip-existing       tag 已存在就整步什么都不做、退 0 —— kernel-<version> 这类
#                            「归档只建一次」的 tag 用得上：灰度→生产提升是同版本第二次
#                            发布，把它判成错误就没法提升（判据见 kernel-ota.yml）
#
#  资产名 = 本地文件的 basename。要换一个名字投（例如把重签后的包投成
#  app-debug.apk），先把文件放进临时目录改好名再传进来，别指望 `#`。
#
#  全文不用管道取数：`set -euo pipefail` 下「命中但左侧 SIGPIPE」会被翻成未命中，
#  这类假阳性本仓已有前科（scripts/verify-apk-native.sh 头部记录）。
# ============================================================================
set -euo pipefail

usage() { echo "[error] 用法: bash scripts/gh-release-upload.sh <release tag> [--title T] [--notes N|--notes-file F] [--prune 正则] [--keep 名称]… [--skip-existing] <文件>…"; }
optval() { [ $# -ge 2 ] || { echo "[error] $1 缺值"; usage; exit 2; }; }

TAG=""
TITLE=""
NOTES=""
NOTES_FILE=""
PRUNE=""
SKIP_EXISTING=0
declare -a KEEPS=()
declare -a FILES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --title)      optval "$@"; TITLE="$2"; shift 2 ;;
    --notes)      optval "$@"; NOTES="$2"; shift 2 ;;
    --notes-file) optval "$@"; NOTES_FILE="$2"; shift 2 ;;
    --prune)      optval "$@"; PRUNE="$2"; shift 2 ;;
    --keep)       optval "$@"; KEEPS+=("$2"); shift 2 ;;
    --skip-existing) SKIP_EXISTING=1; shift ;;
    -*)           echo "[error] 不认识的选项：$1"; usage; exit 2 ;;
    *)            if [ -z "$TAG" ]; then TAG="$1"; else FILES+=("$1"); fi; shift ;;
  esac
done

if [ -z "$TAG" ] || [ "${#FILES[@]}" -eq 0 ]; then
  echo "[error] 参数不齐：需要 <release tag> 和至少一个文件（读到 tag='${TAG:-空}'、文件 ${#FILES[@]} 个）。"
  usage
  exit 2
fi
[ -z "$NOTES" ] || [ -z "$NOTES_FILE" ] || { echo "[error] --notes 与 --notes-file 只能给一个。"; exit 2; }
REPO="${GITHUB_REPOSITORY:-}"
[ -n "$REPO" ] || { echo "::error title=仓库未知::环境里没有 GITHUB_REPOSITORY，gh 不知道该往哪个仓发布 —— 不许猜。"; exit 1; }

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "[error] 要发布的文件不存在或不是普通文件：$f"; exit 2; }
  [ -s "$f" ] || { echo "[error] 要发布的文件是 0 字节：$f —— 空产物投出去等于把线上资产换成没有。"; exit 2; }
done

# ── 1. 线上状态：先看清 Release 在不在 ────────────────────────────────────
# 「读不清」和「不存在」是两回事：把网络失败当成不存在，会去 create 一个本该已存在
# 的 tag，并把这次产物当首次发布 —— 三档语义与 read-release-asset.sh 同构。
CREATE_NEEDED=0
if ! VIEW_ERR="$(gh release view "$TAG" --repo "$REPO" 2>&1 >/dev/null)"; then
  LOW="${VIEW_ERR,,}"
  case "$LOW" in
    *"not found"*|*"does not exist"*|*"could not find"*|*"could not locate"*)
      echo "[gh-release-upload] Release $TAG 不存在，创建中…"
      CREATE_NEEDED=1 ;;
    *)
      echo "::error title=读 Release 失败::看不清 $TAG 的线上状态就不许继续发布（原因：$VIEW_ERR）"
      exit 1 ;;
  esac
elif [ "$SKIP_EXISTING" = 1 ]; then
  echo "[gh-release-upload] Release $TAG 已存在 —— --skip-existing：归档只建一次，本次不动它。"
  exit 0
fi
if [ "$CREATE_NEEDED" = 1 ]; then
  CREATE_ARGS=(gh release create "$TAG" --repo "$REPO" --title "${TITLE:-$TAG}")
  if [ -n "$NOTES_FILE" ]; then
    [ -s "$NOTES_FILE" ] || { echo "[error] --notes-file 指向的文件不存在或为空：$NOTES_FILE"; exit 2; }
    CREATE_ARGS+=(--notes-file "$NOTES_FILE")
  else
    CREATE_ARGS+=(--notes "${NOTES:-由 scripts/gh-release-upload.sh 发布。}")
  fi
  "${CREATE_ARGS[@]}" >/dev/null || { echo "::error title=创建 Release 失败::$TAG 建不出来 —— 本次发布没发生。"; exit 1; }
fi

# ── 2. 线上资产清单：一次取回，后续判定全在纯 shell 里做 ──────────────────
assets_tsv() {
  gh release view "$TAG" --repo "$REPO" --json assets \
    --jq '.assets[] | "\(.name)\t\(.size)"' 2>/dev/null || true
}
asset_size() { # <名称> —— 在 $TSV 里找该名，stdout 打印字节数
  local fld sz name="$1"
  while IFS=$'\t' read -r fld sz; do
    [ -n "$fld" ] || continue
    [ "$fld" = "$name" ] && { printf '%s\n' "${sz:-}"; return 0; }
  done <<<"$TSV"
  return 1
}
delete_asset_by_name() { # <名称> —— 只按清单里真有的 id 删
  local id nm="$1" ids
  ids="$(gh api "repos/$REPO/releases/tags/$TAG" --jq ".assets[] | select(.name==\"$nm\") | .id" 2>/dev/null || true)"
  [ -n "$ids" ] || return 0
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    gh api -X DELETE "repos/$REPO/releases/assets/$id" >/dev/null || {
      echo "::error title=删旧资产失败::$TAG 上的 $nm (id=$id) 删不掉，覆盖上传不能继续。"; return 1; }
  done <<<"$ids"
}

# ── 3. 逐文件覆盖上传 ────────────────────────────────────────────────────
declare -a NAMES=()
declare -a SIZES=()
for f in "${FILES[@]}"; do
  NAME="${f##*/}"
  SIZE="$(stat -c %s "$f" 2>/dev/null || true)"
  [ -n "$SIZE" ] || { echo "::error title=读不出文件大小::$f —— 无法事后确认。"; exit 1; }
  if UP_ERR="$(gh release upload "$TAG" "$f" --repo "$REPO" --clobber 2>&1 >/dev/null)"; then
    echo "[gh-release-upload] clobber $NAME（$SIZE 字节）"
  else
    # 同名资产记录还在、后端对象却孤立/损坏时 --clobber 会 404（2026-09-23 实证）。
    # 正解 = 按名字删掉旧记录再走一次普通上传；这一步原先只有 fast-apk 那份有。
    # 但「先删后传」会把线上唯一的那份资产删没了才失败，所以只对 404 这个特征做回退：
    # 网络抖动/5xx 时旧资产还在、还能下载，此时退 1 让它保持原样，不许动手。
    LOW="${UP_ERR,,}"
    case "$LOW" in
      *404*|*"not found"*)
        echo "[gh-release-upload] clobber $NAME 失败（${UP_ERR//$'\n'/ }），回退为「按名字删旧记录后重传」" ;;
      *)
        echo "::error title=覆盖上传失败::$TAG 上 $NAME 覆盖失败，且失败特征不是孤立资产（${UP_ERR//$'\n'/ }）—— 线上现有资产没被动过，本次发布没发生。"
        exit 1 ;;
    esac
    delete_asset_by_name "$NAME" || exit 1
    gh release upload "$TAG" "$f" --repo "$REPO" >/dev/null 2>&1 || {
      echo "::error title=上传失败::$TAG 上 $NAME 既覆盖不了也新建不了 —— 本次发布没发生。"; exit 1; }
  fi
  NAMES+=("$NAME")
  SIZES+=("$SIZE")
  KEEPS+=("$NAME")
done

# ── 4. 滚动通道清理（--prune 给了才做）──────────────────────────────────
if [ -n "$PRUNE" ]; then
  TSV="$(assets_tsv)"
  while IFS=$'\t' read -r nm sz; do
    [ -n "$nm" ] || continue
    [[ "$nm" =~ $PRUNE ]] || continue
    keep=0
    for k in "${KEEPS[@]}"; do [ "$nm" = "$k" ] && { keep=1; break; }; done
    [ "$keep" = 1 ] && continue
    echo "[gh-release-upload] 清理旧资产 $nm"
    delete_asset_by_name "$nm" || exit 1
  done <<<"$TSV"
fi

# ── 5. 事后确认：上传命令退 0 不等于线上真有了 ───────────────────────────
TSV="$(assets_tsv)"
BAD=""
for i in "${!NAMES[@]}"; do
  CUR="$(asset_size "${NAMES[$i]}" || true)"
  if [ -z "$CUR" ]; then
    BAD="$BAD ${NAMES[$i]}(缺失)"
  elif [ "$CUR" != "${SIZES[$i]}" ]; then
    BAD="$BAD ${NAMES[$i]}(线上 $CUR ≠ 本地 ${SIZES[$i]})"
  fi
done
[ -z "$BAD" ] || { echo "::error title=发布后确认不过::$TAG 上这些资产没对上：${BAD# }—— 别把这一行当发布成功。"; exit 1; }
echo "[gh-release-upload] [ok] $TAG 已就位："
for i in "${!NAMES[@]}"; do printf '  %s  %s 字节\n' "${NAMES[$i]}" "${SIZES[$i]}"; done
