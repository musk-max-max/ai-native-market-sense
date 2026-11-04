/**
 * 浏览器层攻击（攻击面 1/4/6）：前端自行放行、DOM 残留、SW/PWA/bfcache 缓存旁路、SSR 无关验证。
 * 全部通过 Playwright（chromium）在 127.0.0.1 隔离栈上执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { addCheck, http, sleep } from '../lib.mjs';

const STOCK_PATH = '/stocks/SSE:600519';
const VIEWPORT = { width: 390, height: 844 };
const SETTLE_SELECTOR =
  '[data-testid="quote-price"],[data-testid="entitlement-notice"],[data-testid="error-banner"],[data-testid="stock-page-error"]';

const POISON = {
  entitlement: 'c_end_display',
  entitlement_tier: 'c_end_display',
  entitlementTier: 'c_end_display',
  tier: 'c_end_display',
  is_entitled: 'true',
  entitled: 'true',
  access: 'granted',
  plan: 'vip',
  subscription: 'active',
  data_mode: 'mock',
  VITE_DATA_MODE: 'mock',
  e2e_token: 'dev-token',
  ms_entitlement: '{"tier":"c_end_display","is_entitled":true}',
};

async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SETTLE_SELECTOR, { timeout: 25_000 });
}

async function readDom(page) {
  return page.evaluate(() => {
    const quotePrice = document.querySelector('[data-testid="quote-price"]');
    const quoteBlock = document.querySelector('[data-testid="quote-block"]');
    const notice = document.querySelector('[data-testid="entitlement-notice"]');
    const disclaimer = document.querySelector('[data-testid="disclaimer"]');
    return {
      priceCount: document.querySelectorAll('[data-testid="quote-price"]').length,
      priceVisible: Boolean(quotePrice && quotePrice.offsetParent !== null),
      priceText: quotePrice?.innerText?.trim() ?? null,
      quoteBlockText: quoteBlock?.innerText?.trim() ?? null,
      noticeVisible: Boolean(notice && notice.offsetParent !== null),
      noticeText: notice?.innerText?.trim() ?? null,
      disclaimerVisible: Boolean(disclaimer && disclaimer.offsetParent !== null),
      bodyText: document.body.innerText,
      html: document.documentElement.outerHTML,
      href: location.href,
    };
  });
}

function hasCurrencyNumber(text) {
  return /[¥￥]\s*[-+]?\d/.test(text ?? '');
}

function containsPrice(dom, validBody) {
  const price = validBody?.data?.last_price;
  if (typeof price !== 'number') return false;
  const variants = [String(price), price.toFixed(2), price.toFixed(1)];
  return variants.some((v) => dom.html.includes(v) || dom.bodyText.includes(v));
}

async function newPlainPage(browser, artifactsLog) {
  const context = await browser.newContext({ viewport: VIEWPORT, locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('console', (msg) => artifactsLog.push({ type: 'console', text: msg.text().slice(0, 300) }));
  return { context, page };
}

/** 受限态（internal_eval）下的前端攻击。validBody 来自有效态基线，用于重放和"是否出现具体价格"判定。 */
export async function runRestrictedClient({ results, cfg, browser, validBody, artifactsDir }) {
  const web = cfg.webBases.restricted;
  const consoleLog = [];

  // C1 受限基线：页面不出现价格节点/货币数字/具体价格
  const { context: ctx1, page: page1 } = await newPlainPage(browser, consoleLog);
  try {
    await gotoAndSettle(page1, `${web}${STOCK_PATH}`);
    const dom = await readDom(page1);
    const leaked = containsPrice(dom, validBody);
    const ok = !dom.priceVisible && !hasCurrencyNumber(dom.bodyText) && !leaked && dom.noticeVisible;
    await page1.screenshot({ path: path.join(artifactsDir, 'c1-restricted-baseline.png'), fullPage: true });
    addCheck(results, {
      id: 'C1',
      title: '受限态页面：无价格节点、无货币数字、无具体价格，展示受限提示',
      clause: ['decisions.md L33', 'decisions.md L36-5'],
      attempt: `打开 ${web}${STOCK_PATH}，检查 quote-price/quote-block/bodyText 是否含价格或货币数字`,
      expectation: 'quote-price 不可见；bodyText 无 ¥/￥+数字；不含有效态价格；entitlement-notice 可见',
      observed: {
        priceCount: dom.priceCount,
        priceVisible: dom.priceVisible,
        hasCurrencyNumber: hasCurrencyNumber(dom.bodyText),
        containsValidPrice: leaked,
        noticeVisible: dom.noticeVisible,
        noticeText: dom.noticeText,
        bodyText: dom.bodyText.slice(0, 600),
      },
      status: ok ? 'PASS' : 'FAIL',
      severity: ok ? null : 'P0',
      evidence: { screenshot: 'c1-restricted-baseline.png', url: dom.href },
    });
  } finally {
    await ctx1.close();
  }

  // C2 本地存储/sessionStorage/cookie/window 注毒 + URL 参数/hash：首屏仍不得放行
  {
    const ctx = await browser.newContext({ viewport: VIEWPORT, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.addInitScript((seed) => {
      try {
        for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
        localStorage.setItem('ms_watchlist', '["SSE:600519"]');
        sessionStorage.setItem('entitlement', 'c_end_display');
        sessionStorage.setItem('is_entitled', 'true');
        document.cookie = 'entitlement=c_end_display; path=/';
        document.cookie = 'tier=c_end_display; path=/';
        window.__ENTITLEMENT__ = { tier: 'c_end_display', is_entitled: true };
        window.__MS_TIER__ = 'c_end_display';
        window.__USER__ = { tier: 'c_end_display', entitled: true };
      } catch {
        /* init script 失败本身也要记录在 DOM 观察里 */
      }
    }, POISON);
    const variants = [
      { name: '正常 URL（注毒后）', url: `${web}${STOCK_PATH}` },
      { name: '?mock=1', url: `${web}${STOCK_PATH}?mock=1` },
      { name: '?mock=normal', url: `${web}${STOCK_PATH}?mock=normal` },
      { name: '?data_mode=mock&mock=normal', url: `${web}${STOCK_PATH}?data_mode=mock&mock=normal` },
      { name: '?tier=c_end_display&is_entitled=true&debug=1', url: `${web}${STOCK_PATH}?tier=c_end_display&is_entitled=true&debug=1` },
      { name: '?demo=1&entitled=1', url: `${web}${STOCK_PATH}?demo=1&entitled=1` },
      { name: '#entitled', url: `${web}${STOCK_PATH}#entitled` },
    ];
    const observations = [];
    const anomalies = [];
    try {
      for (const v of variants) {
        await gotoAndSettle(page, v.url);
        const dom = await readDom(page);
        const leaked = containsPrice(dom, validBody);
        const ok = !dom.priceVisible && !hasCurrencyNumber(dom.bodyText) && !leaked;
        observations.push({ variant: v.name, priceVisible: dom.priceVisible, priceCount: dom.priceCount, containsValidPrice: leaked, noticeVisible: dom.noticeVisible, bodyText: dom.bodyText.slice(0, 300) });
        if (!ok) anomalies.push(observations.at(-1));
      }
      // 运行时二次注毒 + reload
      await page.evaluate((seed) => {
        for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
        sessionStorage.setItem('entitlement', 'c_end_display');
        window.__ENTITLEMENT__ = { tier: 'c_end_display', is_entitled: true };
      }, POISON);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(SETTLE_SELECTOR, { timeout: 25_000 });
      const domAfter = await readDom(page);
      observations.push({ variant: '运行时注毒后 reload', priceVisible: domAfter.priceVisible, priceCount: domAfter.priceCount, containsValidPrice: containsPrice(domAfter, validBody) });
      if (domAfter.priceVisible || containsPrice(domAfter, validBody) || hasCurrencyNumber(domAfter.bodyText)) anomalies.push(observations.at(-1));
      await page.screenshot({ path: path.join(artifactsDir, 'c2-poisons.png'), fullPage: true });
    } finally {
      await ctx.close();
    }
    addCheck(results, {
      id: 'C2',
      title: 'localStorage/sessionStorage/cookie/window 注毒 + URL 参数/hash 不能让受限页渲染价格',
      clause: ['decisions.md L28', 'decisions.md L36-7'],
      attempt: '首屏前注入 13 个 entitlement/tier/mock 类存储键 + cookie + window.__*；再试 ?mock/?tier/?demo/#hash；最后运行时二次注毒并 reload',
      expectation: '所有变体 priceVisible=false、无货币数字、不含有效态价格',
      observed: anomalies.length === 0 ? `全部 ${observations.length} 个变体被挡住` : anomalies,
      status: anomalies.length === 0 ? 'PASS' : 'FAIL',
      severity: anomalies.length === 0 ? null : 'P0',
      evidence: { observations },
    });
  }

  // C3 应用自身写入的本地存储键：不得包含授权状态
  {
    const { context, page } = await newPlainPage(browser, consoleLog);
    try {
      await gotoAndSettle(page, `${web}${STOCK_PATH}`);
      const keys = await page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
        cookie: document.cookie,
      }));
      const suspicious = [...keys.local, ...keys.session].filter((k) => /entitle|tier|plan|vip|grant|access|mock/i.test(k));
      const ok = suspicious.length === 0;
      addCheck(results, {
        id: 'C3',
        title: '前端不把授权状态写进 localStorage/sessionStorage',
        clause: ['decisions.md L28'],
        attempt: '干净上下文打开受限页后枚举 localStorage/sessionStorage/cookie',
        expectation: '无 entitlement/tier/plan/vip/grant/access/mock 类键',
        observed: { keys, suspicious },
        status: ok ? 'PASS' : 'FAIL',
        severity: ok ? null : 'P2',
        evidence: {},
      });
    } finally {
      await context.close();
    }
  }

  // C4 无 SW/PWA：registrations=0，caches=0
  {
    const { context, page } = await newPlainPage(browser, consoleLog);
    try {
      await gotoAndSettle(page, `${web}${STOCK_PATH}`);
      const state = await page.evaluate(async () => ({
        serviceWorkerSupported: 'serviceWorker' in navigator,
        registrations: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : null,
        cachesSupported: 'caches' in window,
        cacheKeys: 'caches' in window ? await caches.keys() : null,
        manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
      }));
      const ok = state.registrations === 0 && (state.cacheKeys ?? []).length === 0;
      addCheck(results, {
        id: 'C4',
        title: '前端未注册 Service Worker / 未使用 Cache Storage（L35 SW 不缓存行情）',
        clause: ['decisions.md L35', 'decisions.md L36-4'],
        attempt: 'navigator.serviceWorker.getRegistrations() + caches.keys()',
        expectation: 'registrations=0，cacheKeys=[]',
        observed: state,
        status: ok ? 'PASS' : 'FAIL',
        severity: ok ? null : 'P1',
        evidence: {},
      });
    } finally {
      await context.close();
    }
  }

  // C5 响应重放/拦截：客户端是否只信服务端 meta，而不是数据存在就渲染
  {
    const { context, page } = await newPlainPage(browser, consoleLog);
    try {
      const forged = JSON.parse(JSON.stringify(validBody));
      forged.meta.entitlement = { tier: 'internal_eval', is_entitled: false };
      await page.route('**/v1/instruments/SSE:600519/quote*', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(forged) }),
      );
      await gotoAndSettle(page, `${web}${STOCK_PATH}`);
      const domRestricted = await readDom(page);

      const missingDisclaimer = JSON.parse(JSON.stringify(validBody));
      delete missingDisclaimer.meta.disclaimer;
      await page.unroute('**/v1/instruments/SSE:600519/quote*');
      await page.route('**/v1/instruments/SSE:600519/quote*', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(missingDisclaimer) }),
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(SETTLE_SELECTOR, { timeout: 25_000 });
      const domNoDisclaimer = await readDom(page);

      const forgedEntitled = JSON.parse(JSON.stringify(validBody));
      forgedEntitled.meta.entitlement = { tier: 'c_end_display', is_entitled: true };
      await page.unroute('**/v1/instruments/SSE:600519/quote*');
      await page.route('**/v1/instruments/SSE:600519/quote*', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(forgedEntitled) }),
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(SETTLE_SELECTOR, { timeout: 25_000 });
      const domForgedEntitled = await readDom(page);
      await page.screenshot({ path: path.join(artifactsDir, 'c5-interception.png'), fullPage: true });

      const ok = !domRestricted.priceVisible && !hasCurrencyNumber(domRestricted.bodyText) && !domNoDisclaimer.priceVisible;
      addCheck(results, {
        id: 'C5',
        title: '客户端放行只信 meta.entitlement；200+is_entitled=false 或缺免责均不渲染价格',
        clause: ['decisions.md L28', 'decisions.md L36-5'],
        attempt: '拦截 quote 响应重放：①200+数据但 is_entitled=false ②200+数据+is_entitled=true 但删 disclaimer ③200+is_entitled=true 完整（对照）',
        expectation: '①② 不渲染价格；③ 会渲染（客户端以服务端响应为授权依据，属契约行为）',
        observed: {
          restrictedReplay: { priceVisible: domRestricted.priceVisible, bodyText: domRestricted.bodyText.slice(0, 260) },
          missingDisclaimer: { priceVisible: domNoDisclaimer.priceVisible, bodyText: domNoDisclaimer.bodyText.slice(0, 260) },
          fullValidReplay: { priceVisible: domForgedEntitled.priceVisible, priceText: domForgedEntitled.priceText },
        },
        status: ok ? 'PASS' : 'FAIL',
        severity: ok ? null : 'P0',
        evidence: { note: '完整重放渲染价格是预期行为：攻击者若已在网络层篡改响应，等价于持有响应数据；此用例用于证明客户端没有本地放行逻辑' },
      });
    } finally {
      await context.close();
    }
  }

  // C6 受限页内主动 fetch：403 + no-store，且响应体无行情
  {
    const { context, page } = await newPlainPage(browser, consoleLog);
    try {
      await gotoAndSettle(page, `${web}${STOCK_PATH}`);
      const fetched = await page.evaluate(async () => {
        const res = await fetch('/v1/instruments/SSE:600519/quote', { headers: { accept: 'application/json' } });
        const text = await res.text();
        return { status: res.status, cacheControl: res.headers.get('cache-control'), body: text.slice(0, 300) };
      });
      const ok = fetched.status === 403 && (fetched.cacheControl ?? '').includes('no-store') && !/last_price|prev_close/.test(fetched.body);
      addCheck(results, {
        id: 'C6',
        title: '受限页内 fetch 行情仍 403 + no-store + 无行情字段',
        clause: ['decisions.md L35', 'decisions.md L36-4'],
        attempt: 'page.evaluate(fetch /v1/instruments/SSE:600519/quote)',
        expectation: '403；cache-control 含 no-store；body 无 last_price/prev_close',
        observed: fetched,
        status: ok ? 'PASS' : 'FAIL',
        severity: ok ? null : 'P0',
        evidence: {},
      });
    } finally {
      await context.close();
    }
  }
}

/**
 * 跨状态（有效→到期）浏览器测试：
 *   phaseA：有效态页面应显示价格，并留下历史记录；等待到期。
 *   phaseB：bfcache 回退 / 刷新后，页面必须 fail-closed。
 */
export async function startTransition({ results, cfg, browser, artifactsDir }) {
  const web = cfg.webBases.expiring;
  const context = await browser.newContext({ viewport: VIEWPORT, locale: 'zh-CN' });
  const page = await context.newPage();
  const netLog = [];
  const consoleLog = [];
  page.on('console', (msg) => consoleLog.push({ type: 'console', text: msg.text().slice(0, 300) }));
  await page.addInitScript(() => {
    window.__psPersisted = null;
    window.addEventListener('pageshow', (event) => {
      window.__psPersisted = event.persisted;
    });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', (event) => {
    const { url, status, headers, fromDiskCache, fromMemoryCache, fromServiceWorker } = event.response;
    if (/\/quote/.test(url)) {
      netLog.push({
        url,
        status,
        cacheControl: headers['cache-control'] ?? headers['Cache-Control'] ?? null,
        fromDiskCache: Boolean(fromDiskCache),
        fromMemoryCache: Boolean(fromMemoryCache),
        fromServiceWorker: Boolean(fromServiceWorker),
      });
    }
  });

  await gotoAndSettle(page, `${web}${STOCK_PATH}`);
  const dom = await readDom(page);
  await page.screenshot({ path: path.join(artifactsDir, 'c7-valid.png'), fullPage: true });
  addCheck(results, {
    id: 'C7',
    title: '有效态页面正常显示价格（对照基线）',
    clause: ['decisions.md L36-1'],
    attempt: `打开 ${web}${STOCK_PATH}`,
    expectation: 'quote-price 可见且为数值；disclaimer 可见',
    observed: { priceVisible: dom.priceVisible, priceText: dom.priceText, disclaimerVisible: dom.disclaimerVisible, bodyText: dom.bodyText.slice(0, 300) },
    status: dom.priceVisible && /\d/.test(dom.priceText ?? '') ? 'PASS' : 'FAIL',
    severity: dom.priceVisible && /\d/.test(dom.priceText ?? '') ? null : 'P2',
    evidence: { screenshot: 'c7-valid.png' },
  });

  const validBody = await http(`${cfg.apiBases.expiring}/v1/instruments/SSE:600519/quote`).then((r) => r.json);
  // 离开股票页，让历史里留下一个"显示过价格"的页面（bfcache 测试前置）
  await page.goto(`${web}/`, { waitUntil: 'domcontentloaded' });
  await sleep(500);

  return {
    validBody,
    async phaseB() {
      // ① bfcache / 历史回退：返回 cached 页面是否还能看到旧价格
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1500);
      const persisted = await page.evaluate(() => window.__psPersisted ?? null).catch(() => null);
      const domBack = await readDom(page).catch(() => ({ priceVisible: false, priceCount: 0, html: '', bodyText: '' }));
      const bfcacheLeak = Boolean(persisted) && (domBack.priceVisible || containsPrice(domBack, validBody));
      if (domBack.priceVisible) await page.screenshot({ path: path.join(artifactsDir, 'c8-bfcache.png'), fullPage: true });
      addCheck(results, {
        id: 'C8',
        title: '到期后浏览器历史回退（bfcache）不得复用到期前的价格 DOM',
        clause: ['decisions.md L35', 'decisions.md L36-4'],
        attempt: '有效态打开股票页 → 离开 → 等待到期 → history.back()',
        expectation: 'bfcache 若恢复 persisted=true，页面也不得出现价格（需 pageshow/visibilitychange 重新校验）；若重新加载则 403 视图',
        observed: { persisted, priceVisible: Boolean(domBack.priceVisible), priceCount: domBack.priceCount, containsValidPrice: containsPrice(domBack, validBody), bodyText: (domBack.bodyText ?? '').slice(0, 400) },
        status: bfcacheLeak ? 'FAIL' : 'PASS',
        severity: bfcacheLeak ? 'P2' : null,
        evidence: { screenshot: 'c8-bfcache.png', note: bfcacheLeak ? '浏览器进程内保留的 DOM，非网络/服务端放行；需 H5 定级' : '未复用旧 DOM' },
      });

      // ② 刷新：必须 fail-closed，且不出现旧数值
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(SETTLE_SELECTOR, { timeout: 25_000 });
      const domReload = await readDom(page);
      const leakedOnReload = containsPrice(domReload, validBody) || domReload.priceVisible;
      await page.screenshot({ path: path.join(artifactsDir, 'c9-expired-reload.png'), fullPage: true });
      addCheck(results, {
        id: 'C9',
        title: '到期后刷新页面 fail-closed：无价格节点/无旧价格/受限提示可见',
        clause: ['decisions.md L33', 'decisions.md L36-1'],
        attempt: '到期后 page.reload()',
        expectation: 'quote-price 不可见；DOM/bodyText 不含旧价格；entitlement-notice 可见；无货币数字',
        observed: {
          priceCount: domReload.priceCount,
          priceVisible: domReload.priceVisible,
          containsValidPrice: containsPrice(domReload, validBody),
          hasCurrencyNumber: hasCurrencyNumber(domReload.bodyText),
          noticeVisible: domReload.noticeVisible,
          bodyText: domReload.bodyText.slice(0, 600),
        },
        status: !leakedOnReload && domReload.noticeVisible && !hasCurrencyNumber(domReload.bodyText) ? 'PASS' : 'FAIL',
        severity: !leakedOnReload && domReload.noticeVisible && !hasCurrencyNumber(domReload.bodyText) ? null : 'P0',
        evidence: { screenshot: 'c9-expired-reload.png' },
      });

      // ③ 网络层缓存：刷新触发的 quote 请求必须是 403、no-store、非缓存命中
      const lastQuote = [...netLog].reverse().find((e) => e.status === 403) ?? netLog.at(-1) ?? null;
      const cacheOk =
        lastQuote &&
        lastQuote.status === 403 &&
        (lastQuote.cacheControl ?? '').includes('no-store') &&
        !lastQuote.fromDiskCache &&
        !lastQuote.fromMemoryCache &&
        !lastQuote.fromServiceWorker;
      addCheck(results, {
        id: 'C10',
        title: '到期后的行情请求走网络、403、no-store，不复用 200 缓存',
        clause: ['decisions.md L35', 'decisions.md L36-4', 'decisions.md L36-7'],
        attempt: 'CDP Network.responseReceived 记录所有 /quote 响应（status/cache-control/fromDiskCache/fromMemoryCache/fromServiceWorker）',
        expectation: '最后一次 quote 响应 403 + no-store + 三个缓存来源均 false',
        observed: { lastQuote, allQuoteResponses: netLog },
        status: cacheOk ? 'PASS' : 'FAIL',
        severity: cacheOk ? null : 'P0',
        evidence: {},
      });

      // ④ 资源计时：quote 请求 transferSize>0（确实走网络，不是缓存/内存复用）
      const timing = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/quote')).map((e) => ({ name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize })));
      const timingOk = timing.every((t) => t.transferSize > 0 || t.decodedBodySize > 0);
      addCheck(results, {
        id: 'C11',
        title: '到期后 quote 请求不计为缓存命中（Resource Timing 证据）',
        clause: ['decisions.md L35', 'decisions.md L36-4'],
        attempt: 'performance.getEntriesByType("resource") 过滤 /quote',
        expectation: 'transferSize>0 或 decodedBodySize>0（来自网络）',
        observed: { timing, timingOk },
        status: timingOk && timing.length > 0 ? 'PASS' : timing.length === 0 ? 'INFO' : 'FAIL',
        severity: timingOk && timing.length > 0 ? null : timing.length === 0 ? null : 'P1',
        evidence: {},
      });

      // ⑤ DOM 残留：受限页 DOM 里不得残留有效态价格文本（React 卸载后不应留在树里）
      const residue = await page.evaluate(() => {
        const price = document.querySelector('[data-testid="quote-price"]');
        return { priceNodeCount: document.querySelectorAll('[data-testid="quote-price"]').length, priceParent: price?.parentElement?.getAttribute('data-testid') ?? null };
      });
      addCheck(results, {
        id: 'C12',
        title: '到期后 React 树不残留 quote-price 节点',
        clause: ['decisions.md L33'],
        attempt: 'document.querySelectorAll("[data-testid=quote-price]")',
        expectation: '节点数 0（不允许隐藏残留）',
        observed: residue,
        status: residue.priceNodeCount === 0 ? 'PASS' : 'FAIL',
        severity: residue.priceNodeCount === 0 ? null : 'P2',
        evidence: {},
      });

      await context.close();
    },
    async close() {
      await context.close().catch(() => {});
    },
  };
}
