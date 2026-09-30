#!/usr/bin/env bash
#
# APK 形态门禁 —— 「这个包是不是 debuggable」的唯一实现。
# 调用点：fast-apk 一条（docs/adr/0011 之后全仓只剩它投壳 APK），两侧对照各调一次 ——
# debug 档（当前投递的那颗）必须被读成 debuggable，release 档必须被判**非** debuggable，
# 这一对同时为真才证明这把尺子两端都能红。
# 以前「写 apk-latest 的三条链路（build-apk / release-admin publish / repack）」也调它判非
# debuggable，随那三条投递口一起废除。
#
# 为什么必须有（债 AUD-G33）：发布面从建立起只跑过 assembleDebug，而签名门禁查的是「谁签的」。
# 这两件事会同时为真 —— AGP 在仓内有 release keystore 时，连 debug 档都用它签名，
# 于是签名一路绿、投进存量设备更新通道的仍是 debuggable 包（debuggable = 任意 adb shell
# 能以应用身份读私有目录、可被调试器附加）。取证 runbook 长期依赖的正是这个口子，
# 要把它关掉就得先能**读出形态**，而不是拿「文件名没叫 debug」当结论。
#
# 为什么用 aapt dump badging：android:debuggable 是 Manifest 属性，只有资源解析器读得出来。
# APK 的文件名、来源目录、上一个步骤的标记文件都是我们自己写的声明 —— 以声明为输入的门禁
# 量不出线上事实（这一轮整改的根因之一）。
#
# 取不到读数一律判红：找不到 aapt/aapt2、badging 空输出、输出里没有 package: 行 ——
# 「门禁没跑起来」不等于「包是 release 形态」。
#
# 全文不用管道取数：pipefail 下 `… | grep -q` 的命中会被 SIGPIPE 翻成未命中
# （前科见 scripts/verify-apk-native.sh 头部 2026-09-26 的记录），这里整表读进内存后纯 bash 扫。
#
# 用法: bash scripts/verify-apk-release-form.sh <apk> [--expect-debuggable]
# 退出: 0 形态符合预期 / 1 形态不符或无从核验 / 2 用法错误
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK="${1:-}"
shift || true
EXPECT=release
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-debuggable) EXPECT=debug; shift ;;
    *) echo "[error] 未知参数 '$1'"; exit 2 ;;
  esac
done
if [ -z "$APK" ] || [ ! -f "$APK" ]; then
  echo "[error] 用法: bash $0 <apk> [--expect-debuggable]（门禁不许空跑）"
  exit 2
fi

# 探测宿主是 scripts/pick.sh：build-tools 目录下常并存多个版本，--last 取最新；
# --allow-empty 让「没命中」留诊断并把判红交给下面这条自己发起。
AAPT="$(bash "$HERE/pick.sh" --allow-empty --last aapt \
  "${ANDROID_HOME:-/nonexistent}/build-tools" -name aapt -type f 2>/dev/null || true)"
[ -n "$AAPT" ] || AAPT="$(command -v aapt || true)"
TOOL="$AAPT"
if [ -z "$AAPT" ]; then
  # aapt 在新版 build-tools 里可能不随装，aapt2 的 `dump badging` 给同一份文本。
  AAPT2="$(bash "$HERE/pick.sh" --allow-empty --last aapt2 \
    "${ANDROID_HOME:-/nonexistent}/build-tools" -name aapt2 -type f 2>/dev/null || true)"
  [ -n "$AAPT2" ] || AAPT2="$(command -v aapt2 || true)"
  TOOL="$AAPT2"
fi
if [ -z "$TOOL" ]; then
  echo "[error] 找不到 aapt/aapt2（ANDROID_HOME=${ANDROID_HOME:-<未设置>}）—— 形态无从核验，禁止放行。"
  exit 1
fi

BADGE="$("$TOOL" dump badging "$APK" 2>/dev/null)" || {
  echo "[error] $TOOL 读不出 $APK 的 badging —— 无从核验即不放行。"
  exit 1
}
[ -n "$BADGE" ] || { echo "[error] $TOOL 的 badging 输出为空 —— 审计没发生，不放行。"; exit 1; }

mapfile -t LINES <<<"$BADGE"
PKG=""
DEBUGGABLE=0
for line in "${LINES[@]}"; do
  case "$line" in
    # package 行是「解析器真的读到了这个包」的证据；读不到就别谈形态判定。
    package:\ name=*) [ -n "$PKG" ] || PKG="$line" ;;
  esac
  # debuggable 标记是独立一行（aapt 与 aapt2 同形）；按整行匹配，不拿子串去撞
  # application-label 之类的行。
  case "$line" in
    application-debuggable) DEBUGGABLE=1 ;;
  esac
done
if [ -z "$PKG" ]; then
  echo "[error] badging 输出里没有 package: name= 行 —— 解析结果不可信，不放行。"
  echo "        （前 5 行原文）"
  i=0
  for line in "${LINES[@]}"; do
    [ "$i" -lt 5 ] || break
    echo "        $line"
    i=$((i + 1))
  done
  exit 1
fi

echo "[lobos-form] 工具: $TOOL"
echo "[lobos-form] APK: $APK"
echo "[lobos-form] $PKG"
echo "[lobos-form] android:debuggable = $([ "$DEBUGGABLE" = 1 ] && echo true || echo false)"

if [ "$EXPECT" = debug ]; then
  if [ "$DEBUGGABLE" = 1 ]; then
    echo "[lobos-form] [ok] 按预期读成 debug 形态（对照组：证明这把尺子的正例不是空转）"
    exit 0
  fi
  echo "::error title=形态门禁失灵（对照组）::debug 档没被读成 debuggable —— 要么解析没生效，要么判定被改坏，此时 release 侧的绿同样不可信。"
  exit 1
fi

if [ "$DEBUGGABLE" = 1 ]; then
  echo "::error title=发布包是 debug 形态::android:debuggable=true 的包进了版本化归档就是存量设备的更新内容 —— 设备私有目录对任意 adb shell 敞开、可被调试器附加。投递前应跑 assembleRelease。"
  exit 1
fi
echo "[lobos-form] [ok] 非 debuggable（release 形态）"
