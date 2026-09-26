#!/usr/bin/env bash
#
# APK 签名 keystore 注入 —— 「把 secret 变成构建能用的文件，并且当场证它能用」的唯一实现。
# 调用点：fast-apk / build-apk 的 Inject release keystore，release-admin repack 的 Sign APK。
# 三处此前各自抄了一份「base64 解码 + keytool 核验」，而 release-admin 那份把三个 secret
# 直接内插进命令行 —— keystore 口令会出现在 runner 的进程表里。收口后口令只走 env。
#
# 为什么核验要在这里、而不是等 gradle/apksigner：密码错或 base64 残缺时，全量链路
# （build-apk 含 Node 交叉编译，2~3 小时）会一路跑到最后的签名步骤才炸。
#
# 判据（与 scripts/read-release-asset.sh 同一套三档语义）：
#   退 0  = 已注入并核验通过；同时导出 keys/release.cert（PEM），它是
#           scripts/verify-apk-signing.sh 的比对锚点 —— 事实进产物，不留跨步骤的标记文件
#   退 10 = 未配置 ANDROID_KEYSTORE_BASE64 ——「本次就是 debug 签名包」是合法档位，
#           含义由【调用方】决定：日常出包放行并告警，发布链路必须判红
#   退 2  = 配了但注入不成（解码失败 / 密码错 / 别名错 / keytool 不可用）—— 禁止继续构建
#
# 用法: bash scripts/inject-apk-keystore.sh [目标目录，默认 keys]
# 读入: KS_B64(必) KS_PASS(配了 KS_B64 则必) KS_ALIAS(默认 dsh) KS_KEYPASS(默认=KS_PASS)
#       —— 与 fast-apk / build-apk / release-admin 早已在用的那组 secret 同名，不另立一套
set -euo pipefail

DEST="${1:-keys}"
KS="$DEST/release.keystore"
CERT="$DEST/release.cert"

if [ -z "${KS_B64:-}" ]; then
  echo "[dsh-signing] 未配置 ANDROID_KEYSTORE_BASE64 —— 本次产物将是 AGP 现场生成的一次性 debug 签名。"
  echo "[dsh-signing] 后果：指纹每次都不同 ⇒ 新包装到已装设备上会 INSTALL_FAILED_UPDATE_INCOMPATIBLE。"
  echo "[dsh-signing] 发布链路（build-apk / repack）据此判红；日常开发构建放行。"
  exit 10
fi
# 配了 keystore 却没配口令 = 配坏了，不是「未配置」：退 10 会让发布链路把它读成
# 「本轮没密钥」而放行到 debug 签名，正好掩盖掉真因。
[ -n "${KS_PASS:-}" ] \
  || { echo "[error] ANDROID_KEYSTORE_BASE64 已配置但 ANDROID_KEYSTORE_PASSWORD 为空 —— 配坏了，不是没配。"; exit 2; }

mkdir -p "$DEST"
umask 077
if ! printf '%s' "$KS_B64" | base64 -d > "$KS" 2>/dev/null; then
  rm -f "$KS"
  echo "[error] ANDROID_KEYSTORE_BASE64 解码失败（内容被截断或不是 base64）—— 不是「没配密钥」，是配坏了。"
  exit 2
fi
[ -s "$KS" ] || { echo "[error] 解码后是 0 字节 —— 同上，配坏了。"; exit 2; }

# 解码是纯 shell 的事，先做完再要求 keytool：这样「base64 残缺」永远报成残缺，
# 不会被「本机没 JDK」这条更响的诊断盖住（两条都是退 2，但只有前一条指向真因）。
command -v keytool >/dev/null 2>&1 \
  || { echo "[error] keytool 不可用 —— 无法核验注入结果，禁止继续。"; exit 2; }

ALIAS="${KS_ALIAS:-dsh}"
KEYPASS="${KS_KEYPASS:-$KS_PASS}"
export KS_PASS KS_KEYPASS="$KEYPASS"
# 口令一律用 keytool 的 :env 形态传（-storepass:env / -keypass:env，见 keytool(1)：
# modifier 用冒号接在选项后、参数是【环境变量名】）—— 写成 -storepass "$KS_PASS"
# 会把明文口令放进 runner 的进程表与 step 命令行。
# 核验 = 「能列出条目」+「能按别名导出证书」。只查前者会放过别名错的情形，
# 而别名错在构建末端的表现是「密码对却签不出来」，更难查。
if ! keytool -list -keystore "$KS" -storepass:env KS_PASS >/dev/null 2>&1; then
  echo "[error] keystore 读不出条目（ANDROID_KEYSTORE_PASSWORD 不对或文件损坏）。"
  exit 2
fi
if ! keytool -exportcert -rfc -keystore "$KS" -storepass:env KS_PASS \
         -alias "$ALIAS" -keypass:env KS_KEYPASS -file "$CERT" >/dev/null 2>&1; then
  echo "[error] 别名 '$ALIAS' 的证书导不出来（ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD 不匹配）。"
  exit 2
fi
[ -s "$CERT" ] || { echo "[error] 导出的 $CERT 是空的 —— 锚点不可用，禁止继续。"; exit 2; }
PEM_TXT="$(<"$CERT")"
case "$PEM_TXT" in (*"-----BEGIN CERTIFICATE-----"*) ;; (*) echo "[error] 导出的 $CERT 不是 PEM 证书 —— 锚点不可用，禁止继续。"; exit 2 ;; esac

# 指纹只作展示，不参与任何判定：keytool 的指纹行写法在 JDK 版本间变过（历史前科见
# docs/architecture.md：正则写 "SHA256:" 永不匹配 → 健康路径也误报校验失败）。
# 真正的身份比对在 scripts/verify-apk-signing.sh 里做，那里对三种写法都做了归一。
while IFS= read -r ln; do
  case "${ln,,}" in (*"ingerprint"*) echo "[dsh-signing] keystore 证书 $ln" ;; esac
done <<<"$(keytool -printcert -file "$CERT" 2>/dev/null || true)"

# gradle 读这三个变量决定 signingConfig（container/app/build.gradle.kts:93-103，
# 名字要与它逐字对齐）；第四个 DSH_APK_CERT_FILE 是给下游签名身份门禁取锚点用的。
# 一律走 GITHUB_ENV，不把口令写进步骤命令行。
if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "DSH_KEYSTORE_PASSWORD=$KS_PASS"
    echo "DSH_KEY_ALIAS=$ALIAS"
    echo "DSH_KEY_PASSWORD=$KEYPASS"
    echo "DSH_APK_CERT_FILE=$CERT"
  } >> "$GITHUB_ENV"
fi
echo "[dsh-signing] [ok] keystore 已注入并核验：$KS（别名 $ALIAS，锚点 $CERT）"
