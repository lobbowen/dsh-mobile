'use strict';

// Pi —— 第二个载荷（role=agent）。
// 目的：证明"多装一个 Program，Android 观察面不变"（仍是单进程 / 单 FGS / 单通知 / 单承载面）。
// 纪律（公理 D）：载荷不碰任何 Android API —— 这里只用 Node 标准库。
const http = require('http');

const port = Number(process.env.PORT || 0);
const started = Date.now();

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, program: "pi", pid: process.pid, uptimeMs: Date.now() - started }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("pi listening on 127.0.0.1:" + server.address().port + "\n");
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
