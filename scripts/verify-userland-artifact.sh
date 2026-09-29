#!/usr/bin/env bash
# userland 产物形态门禁：一件的「可执行面」必须落成**本容器能兑现的两种形状之一**。
#
#   A. 原生 ELF —— 必须 aarch64 **且动态链接**。动态是硬要求：静态件会绕过 LD_PRELOAD 语义层
#      （2026-09-27 对 bash/rg 的真机定罪）。
#   B. shebang 脚本 —— 首二字节是 `#!`，且解释器写法落在 D1 的兑现范围内：`#!/usr/bin/env X`
#      或 `#!/usr/bin/X`、`#!/bin/X`（execve 前按**调用方 PATH** 解析，见 container/native/d1/exec-path.c）。
#      `#!/system/bin/sh` 这类不在允许形状里：那是 exec-path.c:8-9 已定罪的「逐件手写包装」，
#      也是 base-spec 先前记过、实现里从来不存在的那半句契约（债表 ENV-20）。
#
# 入口路径不写死在这里，也不写死在 workflow：唯一出口是 scripts/read-userland-entry.sh（**无缺省值**，
#   没声明就红）—— 与打包、发布清单读同一份声明，判据不留第二个宿主。
#
# 一件可能有**多颗**可执行面（npm 件同时提供 npm 与 npx）。声明这张表的是件自己（根 package.json 的
#   bin 映射），所以这里把声明到的每一颗都按同一把尺子判 —— 发布器写进清单 tools[].aliases 的那些名字，
#   形状就在这个宿主判过，不在发布器里再长第二份形状判据（ENV-26）。
#
# 这一格只判**形状**。「跑不跑得动」由同一份声明里的能力判据（criteria.<件>.node）在设备上答（ENV-8）。
#   别让形状门禁冒充功能验证，也别拿功能未验证反过来要求形状门禁去猜名单。
#
# 写法纪律：命令替换只在裸赋值里出现，不写 "$(...)"。
set -euo pipefail

TOOL="${1:?需要工具名}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 入口唯一出口：不给默认值（未声明即退 1，本步就红）。
ENTRY=$(bash "$ROOT/scripts/read-userland-entry.sh" "$TOOL")

# judge_shape <件内相对路径> <这一颗叫什么>
judge_shape() {
  local rel="$1" label="$2"
  local BIN="$ROOT/dist/$rel"
  if [ ! -f "$BIN" ]; then
    echo "::error title=缺产物::$label dist/$rel 没产出"; exit 1
  fi
  local MAGIC4 SHAPE
  MAGIC4=$(head -c 4 "$BIN" | od -An -tx1 | tr -d ' \n')
  if [ "$MAGIC4" = "7f454c46" ]; then
    SHAPE=elf
    local INFO
    INFO=$(file -b "$BIN")
    echo "[$TOOL] $label $INFO"
    case "$INFO" in
      *"ARM aarch64"*) : ;;
      *) echo "::error title=产物不是 aarch64::$INFO"; exit 1 ;;
    esac
    case "$INFO" in
      *"dynamically linked"*|*"shared object"*) : ;;
      *) echo "::error title=产物是静态件::$INFO —— 容器 Linux 语义层（LD_PRELOAD）对静态件失效"; exit 1 ;;
    esac
  else
    local HEAD2 LINE1
    HEAD2=$(head -c 2 "$BIN")
    if [ "$HEAD2" != "#!" ]; then
      local INFO
      INFO=$(file -b "$BIN")
      echo "::error title=产物形状不认识::$label 既不是 ELF（前四字节 $MAGIC4）也不是 shebang 脚本（前二字节 \"$HEAD2\"）；$INFO"
      exit 1
    fi
    SHAPE=shebang
    LINE1=$(head -n 1 "$BIN")
    echo "[$TOOL] $label shebang 入口：$LINE1"
    case "$LINE1" in
      '#! /usr/bin/env '*|'#!/usr/bin/env '*) : ;;
      '#!/usr/bin/'*|'#!/bin/'*) : ;;
      *)
        echo "::error title=shebang 不在兑现范围::$label 解释器写法 $LINE1 —— D1 只按 PATH 兑现 env 形态与 /usr/bin、/bin 标准绝对路径；自写 #!/system/bin/sh 包装是已定罪的「中间多了一层」"
        exit 1 ;;
    esac
  fi
  local SIZE
  SIZE=$(stat -c%s "$BIN")
  echo "[ok] $TOOL $label $SIZE 字节 形状=$SHAPE 入口=$rel"
}

judge_shape "$ENTRY" "入口"

# 件自己声明的其余各颗面（原生件没有根 package.json ⇒ 这里零颗，不是缺项）。
FACES=$(node -e '
const fs = require("node:fs"), path = require("node:path");
const p = path.resolve(process.argv[1]);
if (!fs.existsSync(p)) process.exit(0);
let bin;
try { bin = JSON.parse(fs.readFileSync(p, "utf8")).bin; }
catch (e) { console.error("[FAIL] 根 package.json 读不出: " + e.message); process.exit(1); }
if (!bin || typeof bin === "string") process.exit(0);
const skip = process.argv[2];
for (const [name, rel] of Object.entries(bin)) {
  if (typeof rel !== "string" || rel === skip) continue;
  process.stdout.write(name + "\t" + rel + "\n");
}
' "$ROOT/dist/package.json" "$ENTRY") || exit 1
while IFS="$(printf '\t')" read -r ANAME AREL; do
  [ -n "$ANAME" ] || continue
  judge_shape "$AREL" "别名 $ANAME"
done <<< "$FACES"
