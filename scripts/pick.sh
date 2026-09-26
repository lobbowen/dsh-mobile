#!/usr/bin/env bash
# 在 pipefail 的发布脚本里「从 find 的命中里取一个文件」的唯一宿主。
#
# 为什么必须有：发布路径上原有 17 处 `X="$(find … | head -1)"`（15 处在 pipefail 生效的
# 块里，另 2 处所在块只是没开 pipefail，形态一样）。find 自己非零退出（目录不存在、
# 上游变量为空）时，pipefail 把退出码传给赋值，`set -e` 就地中止整个 step ——
# 表现是「步骤红了但一行诊断都没有」，与 build-apk 那次 `make -n` 断言同形态。
# 更坏的是零命中：它可能悄悄走到下一个兜底分支，把「没找到」变成「找了个错的」。
#
# 四种结局都必须可区分，且都带标签：
#   命中       → stdout 打这一条路径，退出 0
#   find 部分失败（多根探测里某个根不存在）但有命中 → warning + 照常取命中
#   无命中     → 默认硬失败并带 find 参数；--allow-empty 降为 warning
#   多命中     → 默认硬失败并列候选（内容同一则无害）；--last 按版本取末位
#
# 用法：pick.sh <标签> [开关…] <find 参数…>   （标签与开关的先后顺序不限）
#   --last         歧义合法时按版本取末位（「取最新 build-tools / 最新 NDK」这类）
#   --allow-empty  无命中只报一行、退出 0。**仅当调用方自己随后判空并硬失败**时才配它；
#                  它存在的意义是保住「find 为什么没命中」这条诊断，同时不把调用方的
#                  兜底分支掐死（pipefail 下裸 `X="$(find … | head -1)"` 会在诊断之前
#                  中止整个 step，导致后面那条更准的判空永远轮不到执行）。
set -uo pipefail

# 第一个非开关参数是标签，其余参数原样交给 find。顺序不限是为了少一个坑：
# 标签写死在第一位，`pick.sh --last apksigner …` 这种顺手写法会把 "--last" 当成标签、
# 把 "apksigner" 当成第一个 find 探测根 —— 于是一次探测不存在的路径，红得莫名其妙。
label=''
ambiguity=strict
allow_empty=0
args=()
for a in "$@"; do
  case "$a" in
    --last) ambiguity=last ;;
    --allow-empty) allow_empty=1 ;;
    *)
      if [ -z "$label" ]; then label="$a"; else args+=("$a"); fi
      ;;
  esac
done

if [ -z "$label" ]; then
  echo '::error title=pick::缺标签。用法: pick.sh <标签> [--last] [--allow-empty] <find 参数…>' >&2
  exit 2
fi
if [ "${#args[@]}" -eq 0 ]; then
  echo "::error title=pick($label)::没有传给 find 的参数（上游变量是不是空的？）" >&2
  exit 2
fi

err="$(mktemp)"
trap 'rm -f "$err"' EXIT
# 参数数组原样透传，不 eval —— 路径里带空格也不能被拆词。
found="$(find "${args[@]}" 2>"$err")"
rc=$?

# find 的退出码与「有没有命中」是两件事：一次传多个探测根时，任何一个根不存在都会
# 让 find 非零，而命中完全可能正常。所以先看有没有命中，再决定这条是 warning 还是失败。
if [ -n "$found" ] && [ "$rc" -ne 0 ]; then
  echo "::warning title=pick($label)::find 部分失败（退出码 $rc：$(head -c 300 "$err")），仍取到命中" >&2
fi

if [ -z "$found" ]; then
  # --allow-empty 下「没命中」也是「这里没有，试下一个」的信号（上游变量本就可能是空串）：
  # 留一条 annotation 让人看得见，判空交给调用方自己的硬失败。
  why="零命中"
  [ "$rc" -eq 0 ] || why="零命中（find 退出码 $rc，stderr: $(head -c 300 "$err")）"
  if [ "$allow_empty" = 1 ]; then
    echo "::warning title=pick($label)::${why}  find ${args[*]}" >&2
    exit 0
  fi
  echo "::error title=pick($label)::$why  find ${args[*]}" >&2
  exit 1
fi

# 命中条数 = 行数（零命中在上面已退出，这里至少 1）。
count=$(printf '%s\n' "$found" | sed -n '$=')

if [ "$ambiguity" = last ] || [ "${count:-1}" -gt 1 ]; then
  # 逐条 sha256 + 大小：多命中时靠它分辨「同一内容的两份」与「两个不同的产物」，
  # 前者无害、后者必须判红 —— 光数条数会把这两种压成同一种。
  sumfile="$(mktemp)"
  trap 'rm -f "$err" "$sumfile"' EXIT
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    sum="$(sha256sum "$f")" || { echo "::error title=pick($label)::sha256 读不到 $f" >&2; exit 1; }
    printf '%s\t%s\t%s\n' "${sum%% *}" "$(stat -c%s "$f")" "$f" >>"$sumfile"
  done <<<"$found"
  # 只取前两个不同摘要就知道是否同内容，不为计数整表去重。
  distinct="$(cut -f1 "$sumfile" | sort -u | sed -n '1,2p' | sed -n '$=')"
  if [ "${count:-1}" -gt 1 ] && [ "${distinct:-1}" -gt 1 ]; then
    if [ "$ambiguity" = strict ]; then
      {
        echo "::error title=pick($label)::多命中且内容不同（$count 条里至少 2 个摘要），无法判定该取哪个"
        echo "  cmd: find ${args[*]}"
        head -10 "$sumfile"
      } >&2
      exit 1
    fi
    echo "::warning title=pick($label)::$count 条命中、内容不完全相同，按版本取末位" >&2
  elif [ "${count:-1}" -gt 1 ]; then
    echo "[pick:$label] $count 条命中，内容同一" >&2
  fi
fi

if [ "$ambiguity" = last ]; then
  # 同内容先按摘要去重，免得两个同字节的不同路径抢「末位」。
  sort -u -k1,1 "$sumfile" | sort -k3,3V | tail -1 | cut -f3
else
  printf '%s\n' "$found" | head -1
fi
