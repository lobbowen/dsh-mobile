#!/usr/bin/env node
'use strict';

// 冒烟测试用 mock 目标：一个最小 HTTP 服务。
// 用法: node mock-target.js <port>
// 环境变量:
//   MOCK_EXIT_ON_START=1  → 启动即退出（测崩溃循环）

const http = require('node:http');

const port = Number(process.argv[2] || 3901);

if (process.env.MOCK_EXIT_ON_START === '1') {
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

server.on('error', (err) => {
  console.error('mock listen error:', err.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock listening on ${port} pid=${process.pid}`);
});

process.on('SIGTERM', () => process.exit(0));
