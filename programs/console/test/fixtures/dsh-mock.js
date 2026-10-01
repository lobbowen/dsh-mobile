#!/usr/bin/env node
'use strict';
const http = require('node:http');
const argv = process.argv.slice(2);
const p = argv.indexOf('--port');
const port = Number(p >= 0 ? argv[p + 1] : 3080);
const s = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"ok":true}'); });
s.listen(port, '127.0.0.1', () => { console.log('dsh-mock on ' + port); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));