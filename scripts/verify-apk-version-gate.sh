#!/usr/bin/env bash
#
# 壳 APK 版本门禁 —— 判据的唯一实现。唯一的调用点是 fast-apk（投壳 APK 的那一条标准链）。
#
# 为什么判据不许写在 workflow 里：2026-09-26 盘点时写滚动通道的有四条链路（fast-apk / build-apk /
# release-admin 的 publish 与 repack），只有 fast-apk 那份比较过版本号，其余三个都是「拿到 APK
# 就覆盖 latest」—— 从旧 run 发一次就能把已升级设备永久锁死（versionCode 回退不可逆，只能卸载
# 重装）。写四份必然漂移，所以收进这一份；2026-09-30 发布连归一（docs/adr/0011）后那三条投递口
# 已删，这份判据的调用点只剩一个 —— **判据留在宿主、而不是跟着口的数量摊开**才是这条收口的本意。
#
# 参照物的**名字**是必填参数（第 4 格），不是写死在这里的一句漂亮话：2026-09-30 定罪（债表 DS-14）查出日常链
#   把参照物写成 apk-latest，而那条通道它自己从不写（滚动别名只由发布面维护）⇒ 这道门从没比过
#   任何数。那时「apk-latest 上没有清单」这句红点读起来像通道坏了，实际是参照物选错了 ——
#   红点必须说清真要比的是谁，否则下次换参照物还是会红在无关的地方。
#
# 为什么线上读数现在有**两格**（第 2 格 = 归档族/Release 清单，第 5 格 = 回执账本）：
#   同日第二次定罪（债表 DS-16）—— 第 2 格那一份是「线上还剩什么」，而它**可以被删**：23:19Z 读到 44、
#   23:52Z 只剩 34，6 个 `v<数字>` 归档被抹掉，门拿着变小了的参照物继续绿。删小参照物 = 自动放松门禁，
#   且从读数上看不出松过。回执账本（scripts/append-apk-receipt.sh 写、独立分支只追加）是那份
#   「删 Release 碰不到」的下界。两格取严（比大的那个），而「取严」本身仍是**这一处**判：
#   取数宿主只交数，不判 —— 判据写第二份就是缺陷（门禁法 §7 第 1 条）。
#
# 为什么同版本重发要分通道：同号换字节 = 用户手里的下载地址指向的东西变了，而版本号没说谎
# 的能力没有了 —— 实证过一次：改 Kotlin 注释合并后 main push 自动重出，1.1.5(7) 的字节
# 在原地被换掉。所以自动通道必须 bump，否则等于把「改了 app 没 bump 版本」这件事静默咽掉。
# 而**归一之后全仓没有任何链路传 explicit**（旧的那格「显式通道 = 修投递」对应的场景已经
# 不存在：投递坏了的正确处置是 bump 一个版本号，见 fast-apk.yml 的 Publish 步）。这一格
# 保留而不是删掉，是因为它是「两格取严」这套判据的对照组，且恢复参照物那件事必须是一次
# **改动 main 的动作**（可审计、会留痕），不能是一朵谁都能按的按钮。
#
# 用法: bash scripts/verify-apk-version-gate.sh <本次 version.json> <线上清单或 '-'> <auto|explicit> <参照物名> <账本清单或 '-'>
#   '-'        = 调用方已确认那一格里确实没有版本读数（尚未发布 / 首次发布），不是「取失败了」
#   <参照物名> = 调用方实际拿谁当线上读数（现在的唯一调用方传 archive = 它自己会写的那一族归档）
#   第 5 格**没有缺省值**：缺省成 '-' 就等于「不记账也能过门」，那正是这一格要防的降级。
# 退出: 0 放行 / 1 判红（不许发布）/ 2 无从校验（同样不许发布，宁可发不出去）
set -euo pipefail

NEW="${1:-}"
OLD="${2:-}"
CHANNEL="${3:-}"
REF="${4:-}"
LEDGER="${5:-}"

die() { echo "::error title=版本门禁::$*" >&2; exit 1; }
usage() {
  echo "[error] 用法: $0 <本次 version.json> <已发布 version.json|-> <auto|explicit> <参照物名> <账本读数 version.json|->" >&2
  exit 2
}

[ -n "$NEW" ] || usage
[ -n "$REF" ] || usage
[ -n "$LEDGER" ] || usage
case "$CHANNEL" in auto|explicit) ;; *) usage ;; esac
if [ "$NEW" != "-" ] && [ ! -f "$NEW" ]; then
  echo "[error] 读不到本次 version.json：$NEW —— 产物自己的版本号都确定不了，不得发布。" >&2
  exit 2
fi

# 版本号取数只用一种写法（node -p）：与发布步骤取 VN/VC 的那句同源，避免两侧解析不一致。
# 必须 path.resolve：require() 拿到不带 ./ 的字符串会当**模块名**去 node_modules 里找
# （实证：node -p "require(process.argv[1])" version.json → MODULE_NOT_FOUND），
# 而调用方传的正是仓库根的相对名。
read_vc() {
  node -p "Number(require(require('node:path').resolve(process.argv[1])).shell.versionCode)" "$1" 2>/dev/null || true
}

# 一格读数的取法，两格共用：'-' → 空串（调用方确认过那里没有数）；
# 文件在却读不出整数 → 非 0（退 2「看不清」）。写成一段是故意的 —— 若归档那格严、
# 账本那格松，坏掉的账本就会被降成「没发过」，而 DS-16 定罪的是同一件事。
read_one() {
  local src="$1" kind="$2" raw
  if [ "$src" = "-" ]; then echo ""; return 0; fi
  if [ ! -f "$src" ]; then
    echo "[error] 传入了${kind}路径却读不到：$src" >&2
    return 3
  fi
  raw="$(read_vc "$src")"
  case "$raw" in
    ''|*[!0-9]*)
      echo "[error] ${kind}的 shell.versionCode 不是整数（读到: ${raw:-空}）—— 读数坏了判「看不清」，不许降成「没有发过」。" >&2
      return 3 ;;
  esac
  echo "$raw"
}

VC_RAW="$(read_vc "$NEW")"
case "$VC_RAW" in
  ''|*[!0-9]*) echo "[error] 本次 version.json 的 shell.versionCode 不是整数（读到: ${VC_RAW:-空}）。" >&2; exit 2 ;;
esac
VC="$VC_RAW"

AVC="$(read_one "$OLD" "线上清单")" || exit 2
LVC="$(read_one "$LEDGER" "账本读数")" || exit 2

# ── 定参照物（PVC / 红点里的参照物名）：两格取严，且「一格空」绝不等于「首次发布」 ──
if [ -z "$AVC" ] && [ -z "$LVC" ]; then
  # 两格都没有读数 = 线上状态整体没建立或整体丢了。
  if [ "$CHANNEL" = auto ]; then
    # 参照物上没有版本读数 = 线上状态丢了。自动发布此时照发，就把「不知道线上是什么版本」
    # 伪装成了「线上就是这一版」。红在这里是对的：先把读数补回去（显式通道发一次），再走自动链。
    die "参照物 $REF 上没有版本读数、回执账本也没起账 —— 这是参照物整体丢了，不是一个发布场景。自动通道不得在线上版本未知的情况下发布：先把下界补回去（账的唯一写入口 scripts/append-apk-receipt.sh，或找回被删的归档族），再推 os-release-* tag。"
  fi
  echo "[version] 参照物 $REF 无版本读数（首次发布或读数丢失），显式通道放行：本次 versionCode=$VC"
  exit 0
elif [ -z "$LVC" ]; then
  # 线上有读数、账本没有：分不清「这条链还没起账」与「账本分支被删过」，而后者恰好是 DS-16
  # 要防的形状（删账 = 参照物自动变小 = 门自动变松）。所以自动通道判红，显式通道把它当起账那一次。
  if [ "$CHANNEL" = auto ]; then
    die "回执账本上没有读数（未起账或已被删）—— 自动通道不许只拿「线上还剩什么」这一格发布：那一格是可以被删小的（债表 DS-16 实测过）。要起账请由人通过账的唯一写入口把下界补回去，再推 os-release-* tag。"
  fi
  PVC="$AVC"
  REF_USED="$REF"
  echo "[version] 警告：回执账本还没有读数，本次只按线上清单比（显式通道 = 起账那一次，发布后由记账链路落第一笔）"
elif [ -z "$AVC" ]; then
  # 线上那格空、账本有读数 —— 这一格的分量就是 DS-16 的主案发现状：归档族被删空。
  # 不许因为「线上看不见包」就降回「首次发布」放行。
  PVC="$LVC"
  REF_USED="回执账本"
  echo "[version] 参照物 $REF 上没有版本读数，但回执账本记到 versionCode=$LVC —— 按账本比，不按首次发布放行"
elif [ "$AVC" -gt "$LVC" ]; then
  # 归档族报得比账本高 = 有一次发布没记进账（或账本被截过）。取严仍按高的比，所以这一格
  # 不放过回退；但「账不全」必须红着看见 —— 下界不可信时继续自动发，等于把门禁的第二只
  # 眼睛换成装饰（同一条纪律：状态丢了要如实可见，不许重试式兜底装成正常）。
  if [ "$CHANNEL" = auto ]; then
    die "线上清单读到 versionCode=$AVC，回执账本只记到 $LVC —— 有一次发布没记账，或账本被截过。先补账/核对 $REF 与账本的差（$AVC vs $LVC），再来发自动通道。"
  fi
  PVC="$AVC"
  REF_USED="$REF"
  echo "[version] 警告：两格读数不一致（线上清单=$AVC > 回执账本=$LVC），按高的那格比；漏记的那次发布请人工核对"
elif [ "$LVC" -gt "$AVC" ]; then
  # 账本报得比线上高 = 线上那格被删小过（本门要救的形状）。照大的比，并把这句话留在日志里，
  # 否则下一次有人拿归档族数量当「发过多少版」的账，又会得出相反的结论。
  PVC="$LVC"
  REF_USED="回执账本"
  echo "[version] 回执账本记到 versionCode=$LVC，高于线上清单的 $AVC —— 线上那格被删小过，按账本比"
else
  # 两格一致 = 正常态；参照物名沿用调用方传入的那格（红点要说清真比的是谁）。
  PVC="$AVC"
  REF_USED="$REF"
fi

echo "[version] 参照物=$REF_USED 已发布 versionCode=$PVC，本次=$VC，通道=$CHANNEL"
if [ "$VC" -lt "$PVC" ]; then
  die "versionCode 回退（$PVC → $VC）：已升级的设备将永远收不到新版本，且不可逆。本次拒绝发布（两种通道都拦）。"
fi
if [ "$VC" -eq "$PVC" ]; then
  if [ "$CHANNEL" = auto ]; then
    die "同版本重发（versionCode=$VC）在自动通道被拒：这次改动动了 APK 内容却没 bump version.json 的 shell.versionCode。请 bump（见 docs/runbook/release.md §2）—— 发布连归一后没有「原地重传」这条路，投递坏了就发下一个版本号。"
  fi
  echo "[version] 同版本重发（versionCode=$VC，显式通道放行 —— 归一后没有任何链路传 explicit，走到这一格就是在跑人工恢复动作）"
  exit 0
fi
echo "[version] 版本前进（$PVC → $VC）"

