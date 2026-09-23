'use strict';
// Dry-run 反代：模拟 OpenAI 兼容端点 + 每key配额(/usage)，用于验证 proxy-runner 链路。
const http = require('node:http');
const crypto = require('node:crypto');
const argv = process.argv.slice(2);
function arg(name, def){ const i=argv.indexOf('--'+name); return i>=0 && argv[i+1] ? argv[i+1] : def; }
// 端口由 ProxyProvider 从统一端口管理分配并注入（--port {{port}}）；此处无默认——
// 缺失 --port 即报错（杜绝散落端口硬编码）
const portArg = arg('port', '');
if (!/^\d+$/.test(portArg)) { console.error('dry-run-proxy: 必须提供 --port（由端口管理分配注入）'); process.exit(1); }
const port = parseInt(portArg, 10);
const apiKey = arg('api-key', process.env.CC_API_KEY || 'dry-key');
const startedAt = Date.now();
// 模拟配额：按 key hash 出不同的 月/周/5h 百分比（每账号不一样）
function mockUsage(){
  const h = parseInt(crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0,6),16);
  const mk = (b) => { const v=(h + b) % 120; const status = v>=100 ? 'rate-limited':'ok'; return { status, percent: Math.min(100,v), resetsAt: new Date(startedAt + (b+1)*3600*1000).toISOString() }; };
  return { rolling: mk(0), weekly: mk(30), monthly: mk(60) };
}
const server = http.createServer((req,res)=>{
  const url = req.url || '/';
  if (url === '/health') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,uptime:Math.round((Date.now()-startedAt)/1000),key:apiKey})); return; }
  if (url === '/usage') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({usage:mockUsage()})); return; }
  if (url === '/v1/models') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({object:'list',data:[{id:'deepseek-v4-flash'},{id:'deepseek-v4-pro'}]})); return; }
  if (url === '/v1/chat/completions') { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ let model=''; try { model=(JSON.parse(b||'{}').model||''); } catch {} res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({id:'dry-run',model:model,choices:[{message:{content:'dry-run ok'} }]})); }); return; }
  res.writeHead(404); res.end('not found');
});
server.listen(port,'127.0.0.1',()=>console.log('dry-run proxy on 127.0.0.1:'+port+' key='+apiKey));
process.on('SIGTERM',()=>process.exit(0));
