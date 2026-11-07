
// 本地 H5 静态服务 + /v1 代理到 ECS API（供 A7 采当前代码 computed-style）
// 目的：ECS web 容器是旧镜像(11-04)，本服务跑当前代码(含 9562a04)。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const API_TARGET_HOST = '127.0.0.1';
const API_TARGET_PORT = 13001; // SSH 隧道 -> ECS:8081
const PORT = 18000;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

function proxy(req, res) {
  const opts = { host: API_TARGET_HOST, port: API_TARGET_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: 'localhost:' + API_TARGET_PORT } };
  const preq = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', (e) => { res.writeHead(502, {'content-type':'application/json'}); res.end(JSON.stringify({error:'api_proxy_unreachable', detail:String(e)})); });
  req.pipe(preq);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/') || req.url.startsWith('/healthz')) return proxy(req, res);
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(DIST, p);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } else {
    // SPA fallback
    res.writeHead(200, { 'content-type': 'text/html' });
    fs.createReadStream(path.join(DIST, 'index.html')).pipe(res);
  }
});
server.listen(PORT, () => console.log('h5-current on :' + PORT + ', /v1 -> ' + API_TARGET_HOST + ':' + API_TARGET_PORT));
