#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]);
const marker = argv[argv.indexOf('--marker') + 1];
const srv = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ ok: true, pid: process.pid })); });
srv.listen(port, '127.0.0.1', () => { try { fs.writeFileSync(marker, String(process.pid)); } catch {} });
process.on('SIGTERM', () => { try { fs.unlinkSync(marker); } catch {} process.exit(0); });
process.on('SIGINT', () => process.exit(0));
