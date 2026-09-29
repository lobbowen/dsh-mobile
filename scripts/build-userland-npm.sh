#!/usr/bin/env bash
# npm —— 与 pnpm/git 同级的 C 层工具，走同一条投放口（不再随 APK 带）。
#
# 为什么不编译：npm 是纯 JS，它没有「编出 aarch64」这一步；上游 tarball 就是产物本体。
#   形态是否合格由 verify-userland-artifact.sh 一处判（形状判据单一宿主），这里不重复一把尺子。
#
# 为什么由 CI 取而不是设备上装：设备所在网络取不到 registry.npmjs.org（GitHub 也不可达），
#   设备唯一的取件口是对象存储 ⇒ 投放动作只能住在发布面。
#
# 入口为什么是 `bin/npm-cli.js` 而不是 `bin/npm`：tarball 的 `package.json` 里 `bin` 映射
#   自己写着 `npm → bin/npm-cli.js`（真读：v11.19.0 的 bin 字段）；而 `bin/npm` 那颗是给
#   Windows/cygwin 安装器用的 bash shim —— 它按 **node 二进制的同级目录** 找
#   `node_modules/npm/bin/npm-cli.js`，我们的 node 在只读的 nativeLibraryDir 里，那个同级
#   永远不存在，脚本自己 `no_node_dir` 退出。所以本件把那颗 bash shim 剪掉，连同只可能被
#   cmd.exe/pwsh 跑的 `*.cmd`/`*.ps1`：留下的判据是「在这台容器里跑不跑得动」，不是体积。
#   设备侧 `$PREFIX/bin/npm` 由清单的 entry 建链（`SupplyProvisioner.linkEntry`），
#   shebang `#!/usr/bin/env node` 由 D1 按 PATH 兑现（`container/native/d1/exec-path.c`）。
#
# 双钉的理由（与 build-userland-pnpm.sh 同一条纪律）：registry 内容不可假设不变。
#   · tarball 的 sha512 = 上游 packument 的 `dist.integrity`；
#   · **入口文件的 sha256 + 字节数** —— 清单钉的是 zip，而 zip 每次重打包字节都不同，
#     所以「按真名 exec 的还是不是那颗入口」只能钉在入口自身上。
#
# 升级 = 主动改这里的三颗钉（版本、sha512、入口 sha256），别指望自动跟随。
set -euo pipefail

HERE=$(dirname "$0")
cd "$HERE/.."
ROOT_DIR=$(pwd)

# 版本本身不写在这里：`assets/node-versions.json` 的 `npm` 字段是设备上那颗 npm 的唯一事实源
#   （ci.yml 的 Program job 用同一格把 runner 的 npm 钉到设备同源）。这里只钉**内容**：
#   版本被抬起而钉子没跟着改，下方 sha512 比对就会红并说出人话 —— 那正是「升级要主动改这里」的强制形态。
NPM_VERSION=$(bash scripts/read-node-versions.sh npm)
TARBALL_SHA512_B64=SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw==
ENTRY_SHA256=8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7
ENTRY_SIZE=54
TARBALL=https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz

# 钉本身先自证形状：sha512 的 base64 恒 88 字且以 == 结尾，sha256 十六进制恒 64 字。
# 抄漏一位 padding 时，比对处的红话会写成「上游内容变了」，把人往错方向支（2026-09-30 CI 实吃到过）。
if [ "${#TARBALL_SHA512_B64}" != 88 ]; then
  echo "::error title=钉本身不合法::sha512 的 base64 应为 88 字，实为 ${#TARBALL_SHA512_B64} 字"
  exit 1
fi
case "$TARBALL_SHA512_B64" in
  *==) : ;;
  *) echo "::error title=钉本身不合法::sha512 的 base64 应以 == 结尾（64 字节 %3==1），实为 ${TARBALL_SHA512_B64: -2}"; exit 1 ;;
esac
if [ "${#ENTRY_SHA256}" != 64 ]; then
  echo "::error title=钉本身不合法::sha256 十六进制应为 64 字，实为 ${#ENTRY_SHA256} 字"
  exit 1
fi

OUT="${OUT:-dist}"
mkdir -p "$ROOT_DIR/$OUT" "$ROOT_DIR/work"

echo "[npm] 取上游 tarball $TARBALL"
if ! curl -fsSL "$TARBALL" -o "$ROOT_DIR/work/npm-${NPM_VERSION}.tgz"; then
  echo "::error title=取不到上游件::$TARBALL"
  exit 1
fi

GOT512=$(openssl dgst -sha512 -binary "$ROOT_DIR/work/npm-${NPM_VERSION}.tgz" | openssl base64 -A)
if [ "$GOT512" != "$TARBALL_SHA512_B64" ]; then
  echo "::error title=tarball sha512 不符::实取 $GOT512 ≠ 钉住的 $TARBALL_SHA512_B64（上游内容变了，升级要主动改这里）"
  exit 1
fi
TB_BYTES=$(stat -c%s "$ROOT_DIR/work/npm-${NPM_VERSION}.tgz")
echo "[npm] tarball $TB_BYTES 字节，sha512 与上游 packument 一致"

# tarball 的顶层目录叫 `package/`，所以整棵树是「解出来后平移一层」：dist 就是件内的 prefix 根。
rm -rf "$ROOT_DIR/work/npm" && mkdir -p "$ROOT_DIR/work/npm"
tar xzf "$ROOT_DIR/work/npm-${NPM_VERSION}.tgz" -C "$ROOT_DIR/work/npm" --strip-components=1

# 剪掉在本容器里跑不动的面（理由见文件头）；其余一律原样保留（docs/man 是 `npm help` 的运行期依赖，
#   读过 lib/commands/help*.js 才决定留 —— 剪它们省 2.6MB，代价是一个能跑的子命令悄悄变半残）。
rm -f "$ROOT_DIR/work/npm/bin/npm" "$ROOT_DIR/work/npm/bin/npx"
find "$ROOT_DIR/work/npm" -type f \( -name '*.cmd' -o -name '*.ps1' \) -delete

SRC="$ROOT_DIR/work/npm/bin/npm-cli.js"
if [ ! -f "$SRC" ]; then
  echo "::error title=件里找不到入口::期望 bin/npm-cli.js（上游改包结构了？）；bin 下实际内容如下"
  ls -la "$ROOT_DIR/work/npm/bin" || true
  exit 1
fi
GOT256=$(sha256sum "$SRC" | cut -d' ' -f1)
if [ "$GOT256" != "$ENTRY_SHA256" ]; then
  echo "::error title=入口 sha256 不符::实取 $GOT256 ≠ 钉住的 $ENTRY_SHA256"
  exit 1
fi
ESIZE=$(stat -c%s "$SRC")
if [ "$ESIZE" != "$ENTRY_SIZE" ]; then
  echo "::error title=入口尺寸不符::$ESIZE ≠ $ENTRY_SIZE"
  exit 1
fi
# 入口必须是 shebang 脚本：这是它「按真名能被解释器跑起来」的全部内容，形状判定归 verify 脚本，
#   这里只保证「钉住的这颗确实是按名字那套语义能兑现的形态」，不写包装、不改 shebang。
HEAD2=$(head -c 2 "$SRC")
if [ "$HEAD2" != "#!" ]; then
  echo "::error title=入口没有 shebang::前二字节不是 #!，按裸名调用不可能被解释器接住"
  exit 1
fi

# 整棵树进件（package-userland.sh 打 dist 的全部内容；运行期要 lib/ 与 node_modules/，只打 bin/ 会得到一颗空壳）
cp -a "$ROOT_DIR/work/npm/." "$ROOT_DIR/$OUT/"
# 入口给执行位：打包进 zip 时 zip 存的是文件属性，设备侧仍按**内容形状**补一遍（ExecBits）——
#   这里补是为了让 verify 与包内属性都对，不是因为设备信任包内属性。
chmod 0755 "$ROOT_DIR/$OUT/bin/npm-cli.js" "$ROOT_DIR/$OUT/bin/npx-cli.js" "$ROOT_DIR/$OUT/bin/npm-prefix.js"
printf '%s\n' "$NPM_VERSION" > "$ROOT_DIR/$OUT/npm.version"
TREE_BYTES=$(du -sb "$ROOT_DIR/$OUT" | cut -f1)
echo "[npm] 产出 $TREE_BYTES 字节的树，入口 $ESIZE 字节 sha256 $GOT256"
