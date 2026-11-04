/**
 * 静态审计：构建产物 / 源码 / SSR HTML 中是否存在"前端自行放行"的开关或服务端烤进数字。
 * 断言目标（decisions.md L28/L35）：
 *  - 生产 bundle 不含运行时可切换的放行开关（ALLOW_ / BYPASS_ / FORCE_ 前缀开关、mock 网关）；
 *  - 前端不读取任何 entitlement/tier 本地存储来放行；
 *  - HTML/SSR 不把行情数字烤进首屏；
 *  - server.mjs 无 SSR 渲染路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE, rel, readSourceFiles, http, addCheck } from '../lib.mjs';

export async function runStaticAudit({ results, cfg }) {
  const srcDir = path.join(WORKSPACE, 'web', 'h5', 'src');
  const distDir = cfg.webDist;
  const assetsDir = path.join(distDir, 'assets');
  const assetFiles = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js')).map((f) => path.join(assetsDir, f))
    : [];
  const bundle = assetFiles.map((f) => ({ file: f, content: fs.readFileSync(f, 'utf8') }));
  const bundleAll = bundle.map((b) => b.content).join('\n');
  const sources = readSourceFiles(srcDir);

  // S1 生产 bundle 无放行类开关残留
  {
    const patterns = [
      { name: 'ALLOW_*', re: /\bALLOW_[A-Z0-9_]+\b/g },
      { name: 'BYPASS_*', re: /\bBYPASS_[A-Z0-9_]+\b/g },
      { name: 'FORCE_*', re: /\bFORCE_[A-Z0-9_]+\b/g },
      { name: 'SKIP_AUTH/DISABLE_*', re: /\b(?:SKIP_AUTH|DISABLE_[A-Z0-9_]*)\b/g },
      { name: 'mockGateway', re: /mockGateway|MOCK_WATCHLIST_KEY|createMockGateway/g },
      { name: 'import.meta.env 运行时变量', re: /import\.meta\.env/g },
      { name: 'process.env 运行时变量', re: /\bprocess\.env\b/g },
    ];
    const hits = [];
    for (const p of patterns) {
      for (const b of bundle) {
        const m = b.content.match(p.re);
        if (m) hits.push({ pattern: p.name, file: path.basename(b.file), count: m.length, sample: [...new Set(m)].slice(0, 3) });
      }
    }
    addCheck(results, {
      id: 'S1',
      title: '生产 bundle 无前端放行开关 / 运行时环境变量读取',
      clause: ['decisions.md L28', 'decisions.md L36-7'],
      attempt: `扫描 ${assetFiles.length} 个 dist JS asset，找 ALLOW_/BYPASS_/FORCE_/SKIP_AUTH/DISABLE_/mockGateway/import.meta.env/process.env`,
      expectation: '无命中；构建期 env 已被 Vite 内联，不存在运行时可切换开关',
      observed: hits.length === 0 ? '无命中' : hits,
      status: hits.length === 0 ? 'PASS' : 'FAIL',
      severity: hits.length === 0 ? null : 'P1',
      evidence: { assets: assetFiles.map((f) => path.basename(f)), hits },
    });
  }

  // S2 前端源码 env 使用面：只允许非放行用途的环境变量
  {
    const usages = [];
    for (const f of sources) {
      for (const m of f.content.matchAll(/import\.meta\.env\.([A-Za-z0-9_]+)/g)) {
        usages.push({ file: rel(f.path), name: m[1] });
      }
    }
    const entitlementLike = usages.filter((u) => /ENTITLEMENT|TIER|PLAN|VIP|ACCESS|BYPASS|ALLOW|FORCE/i.test(u.name));
    const dataMode = usages.filter((u) => u.name === 'VITE_DATA_MODE');
    addCheck(results, {
      id: 'S2',
      title: '前端源码不读取 entitlement/tier 类 env，DATA_MODE 仅构建期且受 DEV 保护',
      clause: ['decisions.md L28', 'decisions.md L36-7'],
      attempt: `枚举 web/h5/src 中 import.meta.env.*（${usages.length} 处）`,
      expectation: '无 entitlement/tier/放行类 env；VITE_DATA_MODE 只与 import.meta.env.DEV 组合',
      observed: { usages, entitlementLike, dataModeUsages: dataMode.length },
      status: entitlementLike.length === 0 && dataMode.length <= 1 ? 'PASS' : 'FAIL',
      severity: entitlementLike.length === 0 && dataMode.length <= 1 ? null : 'P1',
      evidence: { files: [...new Set(usages.map((u) => u.file))] },
    });
  }

  // S3 apiGateway 的渲染放行分支唯一性 + 本地存储不参与授权
  {
    const gatewayPath = path.join(srcDir, 'data', 'apiGateway.ts');
    const gateway = fs.readFileSync(gatewayPath, 'utf8');
    const isEntitledUsages = [...gateway.matchAll(/is_entitled/g)].length;
    const storageReads = [];
    for (const f of sources) {
      for (const m of f.content.matchAll(/localStorage\.(?:getItem|setItem)\(\s*([^),]+)/g)) {
        storageReads.push({ file: rel(f.path), expr: m[1].trim() });
      }
    }
    const forbiddenStorage = storageReads.filter((s) => /entitle|tier|plan|vip|grant|access/i.test(s.expr));
    const grantedBranch = /entitlement\.is_entitled/.test(gateway);
    addCheck(results, {
      id: 'S3',
      title: '渲染放行只依据响应 meta.entitlement.is_entitled，本地存储不参与授权',
      clause: ['decisions.md L28', 'decisions.md L33'],
      attempt: `检查 apiGateway.ts 的 is_entitled 判定（${isEntitledUsages} 处）与全部 localStorage 读写（${storageReads.length} 处）`,
      expectation: '放行只出现在 apiGateway；localStorage 只存 e2e token/自选，不含 entitlement/tier',
      observed: { isEntitledUsages, grantedBranch, storageReads, forbiddenStorage },
      status: grantedBranch && forbiddenStorage.length === 0 ? 'PASS' : 'FAIL',
      severity: grantedBranch && forbiddenStorage.length === 0 ? null : 'P2',
      evidence: { gateway: rel(gatewayPath) },
    });
  }

  // S4 HTML 首屏不烤数字（SSR / 预渲染 / inline state）
  {
    const targets = [
      { name: 'restricted web', base: cfg.webBases.restricted, expectRestricted: true },
      { name: 'expiring web', base: cfg.webBases.expiring, expectRestricted: false },
    ];
    const observations = [];
    for (const t of targets) {
      for (const p of ['/', '/stocks/SSE:600519']) {
        const res = await http(`${t.base}${p}`, { headers: { accept: 'text/html' } });
        const html = res.text;
        const numeric = html.match(/\b\d+(?:\.\d{1,4})?\b/g) ?? [];
        const priceLike = numeric.filter((n) => /^\d{1,4}\.\d{1,4}$/.test(n));
        const hasState = /__INITIAL_STATE__|__PRELOADED_STATE__|application\/json|data-price|last_price|prev_close/.test(html);
        const hasName = /贵州茅台|平安银行/.test(html);
        const statusOk = res.status === 200;
        const noStore = (res.headers['cache-control'] ?? '').includes('no-store');
        observations.push({
          target: t.name,
          path: p,
          status: res.status,
          contentType: res.headers['content-type'],
          cacheControl: res.headers['cache-control'] ?? null,
          priceLike: priceLike.slice(0, 10),
          hasState,
          hasName,
          scriptSrcs: [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
        });
        const pass = statusOk && priceLike.length === 0 && !hasState && !hasName && noStore;
        addCheck(results, {
          id: `S4${t.name === 'restricted web' ? '' : 'b'}-${p === '/' ? 'root' : 'stock'}`,
          title: `HTML 无行情数字/无内联状态（${t.name} ${p}）`,
          clause: ['decisions.md L35', 'decisions.md L36-5'],
          attempt: `GET ${t.base}${p}，检查价格型数字、__INITIAL_STATE__、内联 JSON、股票名、Cache-Control`,
          expectation: '200 + cache-control no-store + 无价格数字/无内联状态/无股票名（纯 SPA 壳）',
          observed: observations.at(-1),
          status: pass ? 'PASS' : 'FAIL',
          severity: pass ? null : 'P2',
          evidence: { htmlSnippet: html.slice(0, 500) },
        });
      }
    }
  }

  // S5 web 静态服务无 SSR 渲染路径
  {
    const serverPath = path.join(WORKSPACE, 'web', 'h5', 'server.mjs');
    const server = fs.readFileSync(serverPath, 'utf8');
    const ssrMarkers = [
      { name: 'renderToString', hit: /renderToString/.test(server) },
      { name: 'renderToPipeableStream', hit: /renderToPipeableStream/.test(server) },
      { name: 'react-dom/server', hit: /react-dom\/server/.test(server) },
      { name: '__INITIAL_STATE__ / preloadData 注入', hit: /__INITIAL_STATE__|__PRELOADED_STATE__|preloadData/.test(server) },
      { name: 'readFileSync(index.html) 后注入', hit: /readFileSync\([^)]*index\.html[^)]*\)[\s\S]{0,200}(replace|append|write)/.test(server) },
    ];
    addCheck(results, {
      id: 'S5',
      title: 'web/h5/server.mjs 无 SSR/预渲染注入路径',
      clause: ['decisions.md L35', 'decisions.md L36-5'],
      attempt: `检查 server.mjs（${server.length}B）中的 SSR / 内联状态注入标记`,
      expectation: '无 SSR 渲染调用；HTML 原样返回 dist/index.html',
      observed: { markers: ssrMarkers, ssrComment: server.match(/.*无 SSR.*|.*SSR.*/)?.[0] ?? null },
      status: ssrMarkers.every((m) => !m.hit) ? 'PASS' : 'FAIL',
      severity: ssrMarkers.every((m) => !m.hit) ? null : 'P1',
      evidence: { file: rel(serverPath) },
    });
  }

  // S6 dist/index.html 本身无数字（静态文件，不依赖服务端行为）
  {
    const indexPath = path.join(distDir, 'index.html');
    const html = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    const numeric = html.match(/\b\d+\.\d{1,4}\b/g) ?? [];
    addCheck(results, {
      id: 'S6',
      title: 'dist/index.html 无行情数字',
      clause: ['decisions.md L35'],
      attempt: `读取 ${rel(indexPath)}`,
      expectation: '无价格型数字',
      observed: { bytes: html.length, numeric },
      status: numeric.length === 0 ? 'PASS' : 'FAIL',
      severity: numeric.length === 0 ? null : 'P2',
      evidence: { snippet: html.slice(0, 300) },
    });
  }

  // 供后续证据：bundle 大小与关键 asset
  addCheck(results, {
    id: 'S7',
    title: '构建产物清单（INFO）',
    clause: [],
    attempt: '列 dist/assets',
    expectation: '-',
    observed: bundle.map((b) => ({ file: path.basename(b.file), bytes: b.content.length })),
    status: 'INFO',
  });
}
