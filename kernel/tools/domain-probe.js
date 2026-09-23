#!/usr/bin/env node
'use strict';

// 执行域探针：只读实测当前 SELinux 域能否 exec app home，以及 link(2) 可用性。依据 docs/ADR-001。
// 用法：node tools/domain-probe.js [--json]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function selinuxContext() {
  try { return fs.readFileSync('/proc/self/attr/current', 'utf8').trim(); } catch { return null; }
}
function probeDir() {
  const base = process.env.DSH_SUPERVISOR_HOME || process.env.TMPDIR || os.tmpdir();
  const d = path.join(base, '.domain-probe');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function status(r, marker) {
  if (r.status === 0 && String(r.stdout || '').includes(marker)) return 'ok';
  return 'fail:' + ((r.error && r.error.code) || ('exit' + r.status)) + ':' + String(r.stderr || '').trim().slice(0, 90);
}

const report = { at: new Date().toISOString(), context: selinuxContext(), platform: process.platform, arch: process.arch };
report.ldPreload = process.env.LD_PRELOAD || 'none';
const d = probeDir();

{ const r = spawnSync('/system/bin/sh', ['-c', 'echo ctl-ok'], { encoding: 'utf8', timeout: 10000 }); report.execSystemShell = status(r, 'ctl-ok'); }

{ const sh = path.join(d, 'probe.sh');
  try { fs.writeFileSync(sh, ['#!/system/bin/sh', 'echo app-data-exec-ok', ''].join(String.fromCharCode(10))); fs.chmodSync(sh, 0o700);
    report.execAppDataScript = status(spawnSync(sh, [], { encoding: 'utf8', timeout: 10000 }), 'app-data-exec-ok'); }
  catch (e) { report.execAppDataScript = 'setup-fail:' + e.code; } }

{ const bin = path.join(d, 'shcopy');
  try { fs.copyFileSync('/system/bin/sh', bin); fs.chmodSync(bin, 0o700);
    report.execAppDataBinary = status(spawnSync(bin, ['-c', 'echo bin-ok'], { encoding: 'utf8', timeout: 10000 }), 'bin-ok'); }
  catch (e) { report.execAppDataBinary = 'setup-fail:' + e.code; } }

{ const a = path.join(d, 'link-src'), b = path.join(d, 'link-dst');
  try { fs.writeFileSync(a, 'x'); fs.rmSync(b, { force: true }); fs.linkSync(a, b); report.link = 'ok'; }
  catch (e) { report.link = 'fail:' + e.code; } }

{ const a = path.join(d, 'ren-src'), b = path.join(d, 'ren-dst');
  try { fs.writeFileSync(a, 'x'); fs.rmSync(b, { force: true }); fs.renameSync(a, b); report.rename = 'ok'; }
  catch (e) { report.rename = 'fail:' + e.code; } }

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log('SELinux 域        : ' + report.context);
  console.log('exec 系统 sh      : ' + report.execSystemShell);
  console.log('exec app 脚本     : ' + report.execAppDataScript);
  console.log('exec app 原生二进制: ' + report.execAppDataBinary);
  console.log('link(2)           : ' + report.link);
  console.log('rename(2)         : ' + report.rename);
  console.log('LD_PRELOAD        : ' + report.ldPreload);
}
