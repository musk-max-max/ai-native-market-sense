#!/usr/bin/env node
/**
 * production 静态服务 + 同源 API 反代（零运行时依赖）。
 *
 * 职责（与 tests/e2e/docker-compose.yml 对齐）：
 *  - 3000 端口提供构建产物 dist/，SPA fallback 支持直接刷新 /stocks/SSE:600519；
 *  - 把 /v1/* 反代到 API_BASE_URL（容器内 http://api:8080），使浏览器侧只需相对路径，
 *    页面请求与 E2E 的 page.request 走同一 origin，不引入 CORS；
 *  - 不修改 API 响应体，只补 X-Forwarded-* 与安全响应头，保持契约原样；
 *  - /v1 响应强制 Cache-Control: no-store（H4/H5：403 与行情不得被缓存复用）；
 *  - 本服务只做静态托管 + 反代，不做 SSR/预渲染，不会把行情数值烤进 HTML。
 */
import http from 'node:http';
import https from 'node:https';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(process.env.WEB_DIST_DIR ?? join(ROOT_DIR, 'dist'));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const API_BASE_URL_RAW = process.env.API_BASE_URL ?? '';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function sendProblem(res, status, code, title) {
  const body = JSON.stringify({ type: 'about:blank', title, status, code });
  res.writeHead(status, {
    'Content-Type': 'application/problem+json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function proxyApi(req, res) {
  if (!API_BASE_URL_RAW) {
    sendProblem(res, 502, 'INTERNAL_ERROR', 'API_BASE_URL 未配置，无法代理 /v1');
    return;
  }

  let target;
  try {
    target = new URL(req.url ?? '/', API_BASE_URL_RAW);
  } catch {
    sendProblem(res, 502, 'INTERNAL_ERROR', 'API_BASE_URL 配置无效');
    return;
  }

  const client = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: target.host };
  delete headers.connection;
  delete headers['keep-alive'];
  delete headers['proxy-connection'];
  delete headers.te;
  delete headers.trailer;
  delete headers['transfer-encoding'];
  delete headers.upgrade;

  const upstream = client.request(
    target,
    { method: req.method, headers, timeout: 30_000 },
    (upstreamRes) => {
      // H4/H5 缓存旁路：行情与 entitlement 响应（含 403）一律 no-store。
      // 不允许浏览器/中间层缓存复用，离线回退也就不会出现旧数值。
      const responseHeaders = {
        ...upstreamRes.headers,
        'cache-control': 'no-store, no-cache, must-revalidate',
      };
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('timeout', () => {
    upstream.destroy(new Error('upstream timeout'));
  });
  upstream.on('error', () => {
    if (!res.headersSent) sendProblem(res, 502, 'INTERNAL_ERROR', '行情服务暂时不可用');
    else res.end();
  });

  req.pipe(upstream);
}

function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relative = decoded.replace(/^\/+/, '');
  const candidate = resolve(DIST_DIR, relative);
  if (candidate !== DIST_DIR && !candidate.startsWith(DIST_DIR + sep)) return null;
  return candidate;
}

function serveFile(req, res, filePath) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = extname(filePath).toLowerCase();
  const isHtml = ext === '.html';
  const headers = {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
  };
  if (isHtml) Object.assign(headers, SECURITY_HEADERS);

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (url.startsWith('/v1/') || url === '/v1') {
    proxyApi(req, res);
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const pathname = url.split('?')[0] ?? '/';

  if (pathname === '/healthz') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const candidate = resolveStaticPath(pathname);
  if (candidate && serveFile(req, res, candidate)) return;

  // SPA fallback：深链（/stocks/SSE:600519、/watchlist）直接刷新时返回 index.html。
  if (pathname.endsWith('/') || !extname(pathname)) {
    const indexPath = join(DIST_DIR, 'index.html');
    if (existsSync(indexPath) && serveFile(req, res, indexPath)) return;
  }

  sendProblem(res, 404, 'NOT_FOUND', '页面不存在');
});

server.listen(PORT, HOST, () => {
  // 只输出必要信息，便于 docker logs / E2E 排障。
  console.log(`[web] listening on http://${HOST}:${PORT}`);
  console.log(`[web] static dir: ${DIST_DIR}`);
  console.log(`[web] api proxy: ${API_BASE_URL_RAW || '(disabled)'}`);
});
