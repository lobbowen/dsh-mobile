#!/usr/bin/env bash
#
# APK 签名身份门禁 —— 「这个包到底是谁签的、能不能装到既有设备上」的唯一实现。
# 调用点：fast-apk（日常出包，允许 debug 身份但必须显式告警）、build-apk（发 apk-latest，
# 必须稳定签名）、release-admin repack（重签之后、投给 apk-latest 之前同样按 stable 档核）。
#
# 为什么要门禁（真实后果，不是洁癖）：AGP 在没有 keystore 时会用 runner 现场生成的
# debug keystore 签名，指纹【每次构建都不同】⇒ 新包装到已装设备上直接
# INSTALL_FAILED_UPDATE_INCOMPATIBLE ⇒「设备自我升级 / 静默升级」整条路不成立。
# build-apk 此前只【写】一个 /tmp/signing-state 标记（全仓零个读取点）就照常发布，
# 于是它能把 debug 签名的包投进 apk-latest —— 那是存量设备的更新通道。本文件补的就是这个洞。
#
# 三档判据（强度不同，别混）：
#   ① 有锚点（--cert，scripts/inject-apk-keystore.sh 导出的 release.cert）：
#      把 APK 内证书的 SHA-256 指纹与锚点指纹比。锚点走指纹而不是 PEM 逐字节，
#      是因为 apksigner verify --print-certs 只打 DN 和摘要、【不打 PEM】——
#      拿它去比 keytool 导出的证书体，判据会永远为红（永远红的门禁等于没有门禁，
#      还会把发布链掐死）。
#   ② --require-stable（发布链路）：非稳定身份一律红。无锚点时只能退到「读 DN 判
#      debug」，此时 [ok] 行会明说【没有可比对的指纹】，不把弱档读成强档。
#   ③ 都没有（未配密钥的日常构建）：debug 身份 → ::warning:: 开发签名（不可发布）。
#
# 取不到读数一律硬红：找不到 apksigner / apksigner 读不出证书 / 输出里没有 DN 行 /
# 指定了锚点却读不出它的指纹 —— 门禁没跑起来不等于签名没问题。
#
# 全文不用管道取数：判据里的 grep|head 组合在 pipefail 下有「命中被翻成未命中」
# 的前科（见 scripts/verify-apk-native.sh 头部 2026-09-26 的记录），这里一律纯 bash 扫描。
#
# 用法: bash scripts/verify-apk-signing.sh <apk> [--cert <release.cert>] [--require-stable]
# 退出: 0 放行 / 1 判红（含无从核验）/ 2 用法错误
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK="${1:-}"
shift || true
EXPECT_CERT=""
REQUIRE_STABLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cert) EXPECT_CERT="${2:-}"; shift 2 ;;
    --require-stable) REQUIRE_STABLE=1; shift ;;
    *) echo "[error] 未知参数 '$1'"; exit 2 ;;
  esac
done
if [ -z "$APK" ] || [ ! -f "$APK" ]; then
  echo "[error] 用法: bash $0 <apk> [--cert <release.cert>] [--require-stable]（门禁不许空跑）"
  exit 2
fi

# 锚点存在性先于工具探测：--cert 是注入步骤的产物，它缺失/为空说明注入没做完，
# 这条诊断比「runner 上没有 apksigner」更接近真因。
if [ -n "$EXPECT_CERT" ] && [ ! -s "$EXPECT_CERT" ]; then
  echo "[error] 指定了锚点 $EXPECT_CERT，但它不存在或为空 —— 注入步骤没做完，不该按「未配密钥」放行。"
  exit 1
fi

# apksigner 的探测宿主是 scripts/pick.sh（多 build-tools 版本取末位即最新）。
# --allow-empty：零命中时保住 find 的为什么，判红由下面这条自己发起。
APKSIGNER="$(bash "$HERE/pick.sh" --allow-empty --last apksigner \
  "${ANDROID_HOME:-/nonexistent}/build-tools" -name apksigner -type f 2>/dev/null || true)"
[ -n "$APKSIGNER" ] || APKSIGNER="$(command -v apksigner || true)"
if [ -z "$APKSIGNER" ]; then
  echo "[error] 找不到 apksigner（ANDROID_HOME=${ANDROID_HOME:-<未设置>}）—— 签名身份无从核验，禁止放行（装不上去是装机之后才知道的）。"
  exit 1
fi

if ! PC="$( "$APKSIGNER" verify --print-certs "$APK" 2>/dev/null )"; then
  echo "[error] apksigner 读不出 $APK 的证书（未签名？损坏？）—— 无从核验即不放行。"
  exit 1
fi

HEX64='^[0-9a-f]{64}$'
# fp_from <多行文本> → 打出一行里「带 sha256 字样」的那条十六进制摘要（小写、无冒号）。
# 三种真实写法都要吃下：apksigner 的 "certificate SHA-256 digest: 1a2b…"、
# keytool 的 "Certificate fingerprint (SHA-256): 1A:2B:…"、
# 以及 keytool 分条列出形态 "\t SHA256: AA:BB:…"；openssl 写成 "…Fingerprint=AA:BB"。
# 做法：整行小写、去掉冒号（把成对的 hex 粘成一个 token）、把 = 当空格，
# 然后取第一个正好 64 位的 hex token。只认 sha*256 行，避免命中 SHA1/MD5 或
# "Signature algorithm name: SHA256withRSA"（它没有 64 位 hex 段）。
fp_from() {
  local line s tok
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    s="${line,,}"; s="${s//:/}"; s="${s//=/ }"
    case "$s" in (*sha*256*) ;; (*) continue ;; esac
    read -ra TOKS <<<"$s"
    for tok in "${TOKS[@]}"; do
      if [[ "$tok" =~ $HEX64 ]]; then printf '%s\n' "$tok"; return 0; fi
    done
  done <<<"$1"
  return 0
}

DN=""
while IFS= read -r line; do
  case "${line,,}" in
    *"certificate dn"*) DN="$line"; break ;;
  esac
done <<<"$PC"
FP="$(fp_from "$PC")"
if [ -z "$DN" ]; then
  echo "[error] apksigner 输出里没有 certificate DN 行 —— 解析不到签名身份，不放行。"
  exit 1
fi

echo "[dsh-signing] apksigner: $APKSIGNER"
echo "[dsh-signing] APK: $APK"
echo "[dsh-signing] $DN"
echo "[dsh-signing] SHA-256 指纹: ${FP:-（apksigner 输出里没解析到 sha-256 摘要行）}"

IS_DEBUG=0
case "${DN,,}" in (*"android debug"*) IS_DEBUG=1 ;; esac

if [ -n "$EXPECT_CERT" ]; then
  # 锚点指纹：优先 keytool（注入侧就是它导出的证书，同一工具链最可比），退 openssl。
  CT=""
  if command -v keytool >/dev/null 2>&1; then
    CT="$(keytool -printcert -file "$EXPECT_CERT" 2>/dev/null || true)"
  fi
  if [ -z "$CT" ] && command -v openssl >/dev/null 2>&1; then
    CT="$(openssl x509 -noout -fingerprint -sha256 -in "$EXPECT_CERT" 2>/dev/null || true)"
  fi
  [ -n "$CT" ] || { echo "[error] 锚点 $EXPECT_CERT 读不出证书内容（keytool/openssl 都不可用，或它不是证书）—— 无从核验即不放行。"; exit 1; }
  CERT_FP="$(fp_from "$CT")"
  [ -n "$CERT_FP" ] || { echo "[error] 锚点输出里没有 SHA-256 指纹 —— 无从核验即不放行。"; exit 1; }
  [ -n "$FP" ] || { echo "[error] APK 侧读不出 SHA-256 指纹，无法与锚点比对 —— 不放行。"; exit 1; }
  if [ "$FP" != "$CERT_FP" ]; then
    echo "::error title=签名身份不符::APK 内证书指纹 $FP ≠ 本次注入 keystore 的指纹 $CERT_FP —— 签名配置指错了 key（换过 keystore / 别名取错），装到既有设备上必失败。"
    exit 1
  fi
  echo "[dsh-signing] [ok] APK 证书指纹与注入锚点一致（${EXPECT_CERT##*/} = $FP）"
  if [ "$REQUIRE_STABLE" = "1" ] && [ "$IS_DEBUG" = "1" ]; then
    # 一致只证明「签名配置生效」，不证明「这把 key 是稳定的」。发布链路两个都要：
    # 有人会把本地 debug keystore 灌进 ANDROID_KEYSTORE_BASE64，那等于没配。
    echo "::error title=发布包是 debug 签名::锚点虽一致，但它本身就是 Android Debug 身份 —— 换 keystore 后存量设备照样装不上。"
    exit 1
  fi
  exit 0
fi

if [ "$IS_DEBUG" = "1" ]; then
  if [ "$REQUIRE_STABLE" = "1" ]; then
    echo "::error title=发布包是 debug 签名::本链路产物会投给存量设备（apk-latest），一次性 debug 签名会把它们打成 INSTALL_FAILED_UPDATE_INCOMPATIBLE —— 请配置 ANDROID_KEYSTORE_BASE64 后重跑。"
    exit 1
  fi
  echo "::warning title=开发签名（不可发布）::未配置 ANDROID_KEYSTORE_BASE64，本次为 debug 签名；既有设备无法覆盖安装，且无自我升级能力。见 docs/runbook/release.md"
  exit 0
fi

if [ "$REQUIRE_STABLE" = "1" ]; then
  echo "[dsh-signing] [ok] 非 debug 签名（发布链路放行）。⚠ 本次【没有】可比对的锚点指纹 —— 只证明了「不是 debug」，没证明「是哪把 key」。"
  exit 0
fi
echo "::warning title=签名身份无从核验::未配 keystore 却拿到非 debug 签名 —— 没有锚点能证明它是【哪一把】key。发布请走配了 ANDROID_KEYSTORE_BASE64 的链路。"
