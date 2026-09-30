#!/usr/bin/env bash
#
# 「gh 这句报错是不是『那个东西不存在』」—— 取数三态（取到 / 确实没有 / 看不清）里那一分叉的唯一判据。
# 调用点（一律 source，不抄词表）：scripts/read-release-asset.sh、scripts/read-apk-receipts.sh、
# scripts/gh-release-upload.sh。
#
# 为什么只能有一份：收口前三处各一张表（两个 reader 一张、投递口一张，投递口比它们宽），于是同一句
# 报错在投递口算「不存在」（去 create 一个本该存在的 Release），在取数口算「看不清」（判红退出）——
# 两条链对同一件线上事实的结论相反。债表 DS-16 定的罪正是「线上归档被整族删掉而门无感」：把读失败
# 算成「不存在」，投递口就会把删掉的载体重新造出来，看上去一切正常。
#
# 词表只收**明确指向「那个东西不在」**的措辞。刻意不收 could not find / could not locate：那两句在
# gh 里也可能是仓名/remote 解析不成，属于「看不清」；收进来等于让取数口把鉴权与配置故障读成
# 「线上没有」，那是最危险的一侧被放行（投递口因此变严：认不出就退，不 create）。
#
# 刻意不进本判据的另一处：gh-release-upload.sh 的「孤立资产回退」只认 404 / not found，它问的是
# 「敢不敢删掉线上唯一那份再重传」；词表放宽到这里会让一次网络抖动触发删资产。
#
# 用法: source "$(dirname "$0")/gh-absence.sh"; gh_absent "$报错文本"   # 退 0 = 确实不存在
gh_absent() {
  case "${1,,}" in
    *"not found"*|*"does not exist"*|*"http 404"*|*"no assets"*|*"matching pattern"*|*"no ref found"*) return 0 ;;
    *) return 1 ;;
  esac
}
