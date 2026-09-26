'use strict';

// 测试运行器（镜像内核仓风格）：results[] + check() 打印 PASS/FAIL，结尾打印「结果: X passed, Y failed[, Z skipped]」。
// skip() 是**唯一合法的"少验"出口**：跳过必须逐条打行、进汇总计数——
// 用 check('（跳过）…', true) 把跳过伪装成 PASS 是禁止的（会让 grep -c '^PASS' 的 CI 汇总说谎）。
module.exports = function makeRunner(name) {
  const results = [];
  let skipped = 0;
  const check = (n, c, x) => {
    results.push(!!c);
    console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
  };
  const skip = (n) => {
    skipped++;
    console.log('SKIP ' + n);
  };
  const finish = () => {
    const failed = results.filter((r) => !r);
    console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed' + (skipped ? ', ' + skipped + ' skipped' : '') + (name ? '  (' + name + ')' : ''));
    process.exit(failed.length ? 1 : 0);
  };
  return { results, check, skip, finish };
};
