'use strict';

// 私钥锚点解析（签名侧）。公钥锚点 container/app/src/main/assets/ota-public.pem
// 焊进 APK、由 CI 直接读文件比对（build-apk.yml），不经本模块。
// 可用环境变量 DSH_OTA_PRIVATE_KEY_PATH 覆盖（测试隔离用）。

const fs = require('fs');
const path = require('path');

const DEFAULT_PRIVATE_KEY_PATH = path.resolve(__dirname, '..', '..', '..', 'keys', 'ota-private.pem');

function loadPrivateKey(p) {
  const fp = p || process.env.DSH_OTA_PRIVATE_KEY_PATH || DEFAULT_PRIVATE_KEY_PATH;
  return fs.readFileSync(fp, 'utf8');
}

module.exports = { DEFAULT_PRIVATE_KEY_PATH, loadPrivateKey };
