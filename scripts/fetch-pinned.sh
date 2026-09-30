#!/usr/bin/env bash
#
# C 层构建口取上游源码的**唯一**入口：下载 → 与钉住的 sha256 逐字节校验 → 只有相等才算拿到。
#
# 为什么要有它（2026-09-30 CI 现读定罪）：curl/git 两颗件的构建口写的是「候选 URL 列表，
# 谁先通就用谁」，而**同一个版本的两条来源本来就是两批字节** —— 实测 zlib 1.3.2：
#   zlib.net/fossils/zlib-1.3.2.tar.gz   1,502,830 B  bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
#   github.com/madler/zlib/archive/...   1,566,911 B  b99a0b86c0ba9360ec7e78c4f1e43b1cbdf1e6936c8fa0f6835c0cd694a495a1
# （后者是 GitHub 按 tag 现生成的 archive，目录名前缀与打包方式都不同。）于是件的 sha256
# 取决于**构建那一刻哪条镜像先答**：同一 commit 隔 20 分钟跑两轮，curl 的指纹就从
# 0b9c9f0db078 变成 6fe1addf3d84。而件的 URL 里那 12 位就是这颗 sha，清单又钉这个 sha ——
# 「同一版本号只许一批字节」（scripts/check-userland-manifest-drift.js --immutable 的第 ② 格）
# 在没钉源之前**根本做不到**， drift 判红也就永远归不了零。
#
# 件的字节身份必须由**仓内声明**决定，不由网络状况决定。所以这里不认「像不像 tar.gz」，
# 只认 sha256 相不相等；多条来源是**镜像故障转移**，不是「换一批字节」的许可。
#
# 用法: bash scripts/fetch-pinned.sh --pin <键> <落点> [--version-file <件版本格>]
#       bash scripts/fetch-pinned.sh <落点> <期望 sha256> <url> [url...]   ← 自测/离线用的裸档
#       bash scripts/fetch-pinned.sh --time-base| --ndk    ← 只读表里的构建基准／工具链版本（不下载）
#   这两档存在的原因：件的字节不只由源码决定（还由构建时刻与交叉编译器决定），而这些定值必须
#   和源码钉值住在**同一张表、同一个读者**里 —— 让第二个脚本去解析这张表就是两个结论的入口。
# 退出: 0 = 取到且逐字节等于钉值
#       2 = 一条都不合（下载失败或校验不匹配都算）—— 一律判红，绝不「校验失败也用它」，
#           也不把「取不到」降成 warning 后继续编译（那等于把没有身份来源的字节投给设备）。
#
# --version-file：**由这次取数自己写那一格**。件声明的版本与它取到的源码必须是同一个事实 —— 
#   构建口里再写一遍 `X_VERSION=1.2.3` 就是第二个事实源，两处各写一个版本号可能得到
#   「取的是 8.22.0 的字节、往清单里写 8.23.0 的号」。版本只在核验通过之后才落盘，
#   所以「件有版本格」这件事本身就证明那批字节对过钉值。裸档不给这个口子（没有表就没有身份）。
#
# 钉值住 scripts/userland-sources.json 一份：键不在表里、表读不出、version/sha/urls 形状不合法
# 都在取数**之前**判红 —— 「读不到就当清白」正是这类门禁最空的空转口。
set -euo pipefail

die() { echo "::error title=源码钉值不合::$*" >&2; exit 2; }

HERE=$(dirname "$0")
ROOT_DIR=$(cd "$HERE/.." && pwd)
TABLE="$ROOT_DIR/scripts/userland-sources.json"

OUT=""
WANT=""
VER=""
URLS=()
VERSION_FILE=""

if [ "${1:-}" = "--pin" ]; then
  KEY="${2:-}"
  OUT="${3:-}"
  [ -n "$KEY" ] && [ -n "$OUT" ] || die "用法: $0 --pin <键> <落点>（键见 $TABLE）"
  shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --version-file) VERSION_FILE="${2:-}"; [ -n "$VERSION_FILE" ] || die "--version-file 后面没给落点"; shift 2 ;;
      *) die "--pin 这一档只认 --version-file，读到的是：$1" ;;
    esac
  done
  # 只在这里解一次表：构建口拿不到 sha 也拿不到 URL，所以「绕过钉值自己 curl」这条路
  # 要靠表本身不可读才能走通 —— 那条由 container/engine/test/source-pin-test.js 扫调用点钉住。
  if ! META="$(node -e '
    const path = require("node:path");
    let tab;
    try { tab = require(path.resolve(process.argv[1])); } catch (e) { console.error("钉值表读不出: " + e.message); process.exit(1); }
    const s = (tab.sources || {})[process.argv[2]];
    if (!s) { console.error("键 " + process.argv[2] + " 不在钉值表里（现有: " + Object.keys(tab.sources || {}).join(", ") + "）"); process.exit(1); }
    if (!/^[0-9a-f]{64}$/.test(String(s.sha256))) { console.error("键 " + process.argv[2] + " 的 sha256 不是 64 位小写十六进制: " + String(s.sha256)); process.exit(1); }
    if (!s.version || !String(s.version).trim()) { console.error("键 " + process.argv[2] + " 没有 version 格"); process.exit(1); }
    if (!Array.isArray(s.urls) || s.urls.length === 0) { console.error("键 " + process.argv[2] + " 的 urls 是空的"); process.exit(1); }
    process.stdout.write(String(s.sha256) + "\n" + String(s.version) + "\n" + s.urls.join("\n") + "\n");
  ' "$TABLE" "$KEY")"; then
    die "钉值表这一格读不通：$KEY"
  fi
  { IFS= read -r WANT; IFS= read -r VER; mapfile -t URLS; } <<< "$META"
elif [ "${1:-}" = "--time-base" ]; then
  # 件里嵌的构建时间基准也住这张表，而表的读者必须只有本脚本一个（⑦ 那条判据）。
  # 校验形状与「必须早于现在」都在这里判：钉在未来等于没钉（墙钟还没走到，重建每次都取 time()）。
  if ! TB="$(node -e '
    const path = require("node:path");
    let tab;
    try { tab = require(path.resolve(process.argv[1])); } catch (e) { console.error("钉值表读不出: " + e.message); process.exit(1); }
    const v = tab.buildTimeEpoch;
    if (!Number.isInteger(v) || v <= 0) { console.error("buildTimeEpoch 必须是正整数秒（现在: " + JSON.stringify(v) + "）"); process.exit(1); }
    if (v * 1000 >= Date.now()) { console.error("buildTimeEpoch=" + v + " 不早于现在，钉不住墙钟"); process.exit(1); }
    process.stdout.write(String(v));
  ' "$TABLE")"; then
    die "钉值表的 buildTimeEpoch 这一格读不通"
  fi
  echo "$TB"
  exit 0
elif [ "${1:-}" = "--ndk" ]; then
  # 交叉编译用的 NDK 版本也住这张表，表的读者仍然只有本脚本（⑦ 那条判据）。
  # 这里**只取不判**：NDK 不是下载来的源码，「实际用的那版等不等于钉值」由 build-userland 的
  # 「定位 NDK」步在 runner 上判（那里才有两侧读数可比）。
  if ! ND="$(node -e '
    const path = require("node:path");
    let tab;
    try { tab = require(path.resolve(process.argv[1])); } catch (e) { console.error("钉值表读不出: " + e.message); process.exit(1); }
    const v = tab.ndkVersion;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(v))) { console.error("ndkVersion 不是 x.y.z 形态（读到 " + JSON.stringify(v) + "）"); process.exit(1); }
    process.stdout.write(String(v));
  ' "$TABLE")"; then
    die "钉值表的 ndkVersion 这一格读不通"
  fi
  echo "$ND"
  exit 0
elif [ $# -ge 3 ]; then
  OUT="${1:-}"
  WANT="${2:-}"
  shift 2
  URLS=("$@")
else
  die "用法: $0 --pin <键> <落点>  或  $0 --time-base  或  $0 --ndk  或  $0 <落点> <期望 sha256> <url> [url...]（参数少一个都不算数）"
fi

[ -n "$OUT" ] && [ -n "$WANT" ] && [ "${#URLS[@]}" -gt 0 ] \
  || die "落点/钉值/来源三样少一样（--pin 那档由表供给后两样）"
[[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || die "钉值不是 64 位小写十六进制 sha256：$WANT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for url in "${URLS[@]}"; do
  # file:// 只服务于自测与离线复现（表里每一格钉的都是 https 来源，那一格由
  # container/engine/test/source-pin-test.js 扫表与调用点分别钉住）。安全性来自 sha256，不来自传输。
  case "$url" in https://*|file://*) ;; *) die "来源既不是 https 也不是 file：$url" ;; esac
  f="$TMP/download"
  if ! curl -fsSL --max-time 900 "$url" -o "$f"; then
    echo "[fetch-pinned] 下载失败，换下一条来源：$url"
    continue
  fi
  got="$(sha256sum "$f" | cut -d' ' -f1)"
  if [ "$got" != "$WANT" ]; then
    echo "[fetch-pinned] 来源 $url 不合钉值：实得 $got（期望 $WANT）—— 这不是同一批字节，换下一条"
    continue
  fi
  mkdir -p "$(dirname "$OUT")"
  mv "$f" "$OUT"
  if [ -n "$VERSION_FILE" ]; then
    mkdir -p "$(dirname "$VERSION_FILE")"
    printf '%s\n' "$VER" > "$VERSION_FILE"
    echo "[fetch-pinned] 件版本格 $VERSION_FILE = $VER（这一格由这次取数写，与钉值是同一个事实）"
  fi
  echo "[fetch-pinned] 校验通过：$(basename "$OUT") 钉值表 version=${VER:-未名} sha256=$got 来源=$url"
  exit 0
done

die "所有来源都不合钉值 $WANT（共 ${#URLS[@]} 条）—— 宁可不编译，也不许用没有身份的源码出件。"
