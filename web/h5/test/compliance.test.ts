/**
 * 合规文案测试（H3 出口）。
 *
 * 1) 用户可见文案只在 lib/copy.ts 出现：其他 src 文件（去掉注释后）不得有中文字面量。
 *    这条测试防止「现场写中文」和「错误码直接渲染」回潮。
 * 2) 四态文案映射正确：正常不需要错误文案；403 中性、不含法律定性；
 *    429 不暴露限流原因；断网与 5xx 文案不同。
 * 3) 埋点白名单只放行公开字段，内部标识/个人标识一律丢弃。
 * 4) copy 版本轴：快照 <version>.<hash12>.frontend.json 与 docs/release/copy-version-manifest.md 互相引用（后端由 A0 配对填写）。
 *
 * 运行：pnpm --filter @market-sense/h5 check:compliance
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { COPY_VERSION, ERROR_COPY, copy, errorCopy } from '../src/lib/copy.ts';
import { sanitizeProps } from '../src/lib/analytics.ts';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const H5_DIR = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/** 去掉块注释与整行注释，避免把说明文字误判成用户可见文案。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('除 copy.ts 外，src 中没有中文字面量（文案单一来源）', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC_DIR)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    if (file.endsWith(join('lib', 'copy.ts'))) continue;
    // mockGateway 是仅开发可用的 fixture（含示例证券名/免责样本），生产构建被摇树删除；
    // 它不是 UI 文案实现，见下一条测试对 DEV 守卫的断言。
    if (file.endsWith(join('data', 'mockGateway.ts'))) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    const matches = code.match(/[\u4e00-\u9fff]/g);
    if (matches) offenders.push(`${relative(H5_DIR, file)}（${matches.length} 处）`);
  }
  assert.deepEqual(offenders, [], `以下文件含硬编码中文，请改从 lib/copy.ts 引用：${offenders.join('、')}`);
});

test('403 文案中性：不出现法律定性、不伪装成故障/不存在/退市', () => {
  const text = `${copy.entitlement.title}${copy.entitlement.body}${copy.entitlement.hint}`;
  assert.ok(text.includes('暂不提供'), '403 文案应陈述「当前版本暂不提供」这一事实');
  for (const banned of ['授权', '牌照', '未取得', '网络异常', '加载失败', '不存在', '退市']) {
    assert.equal(text.includes(banned), false, `403 文案不得包含「${banned}」`);
  }
});

test('429 文案不暴露限流内部原因', () => {
  const text = `${ERROR_COPY.status429?.title ?? ''}${ERROR_COPY.status429?.message ?? ''}`;
  for (const banned of ['频繁', '限流', '阈值', '额度', 'QPS']) {
    assert.equal(text.includes(banned), false, `429 文案不得包含「${banned}」`);
  }
});

test('状态码映射：断网/服务端/受限/未知给出不同文案，且未知状态有兜底', () => {
  const network = errorCopy(null, true);
  const server = errorCopy(503, false);
  const forbidden = errorCopy(403, false);
  const unknown = errorCopy(null, false);
  assert.notEqual(network.title, server.title);
  assert.notEqual(forbidden.title, network.title);
  assert.notEqual(unknown.title, forbidden.title);
  // 契约外的状态码必须落到兜底，不把状态码当文案。
  assert.equal(errorCopy(418, false).title, unknown.title);
});

test('埋点白名单只放行公开字段，内部标识与个人标识被丢弃', () => {
  const payload = sanitizeProps('stock_page_view', {
    instrumentId: 'SSE:600519',
    uiState: 'ready',
    // @ts-expect-error 模拟越权字段
    channel: 'appstore',
    // @ts-expect-error 模拟内部字段
    tier: 'internal',
    // @ts-expect-error 模拟个人标识
    phone: '13800000000',
  });
  assert.deepEqual(payload, { instrumentId: 'SSE:600519', uiState: 'ready' });

  const invalid = sanitizeProps('stock_page_view', { instrumentId: 'not-an-instrument' });
  assert.deepEqual(invalid, {});

  const routeOnly = sanitizeProps('page_view', { route: 'home', instrumentId: 'SSE:600519' });
  assert.deepEqual(routeOnly, { route: 'home' });
});

test('index.html 的 noscript 与 copy.app.noscript 双向逐字一致（规范化空白/实体后）', () => {
  const html = readFileSync(join(H5_DIR, 'index.html'), 'utf8');
  const match = /<noscript>([\s\S]*?)<\/noscript>/.exec(html);
  assert.ok(match, 'index.html 必须保留 <noscript> 兜底');
  const normalize = (value: string) =>
    value
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  const inHtml = normalize(match[1] ?? '');
  const inCopy = normalize(copy.app.noscript);
  assert.equal(inHtml, inCopy, '改 copy 不改 html、改 html 不改 copy 都必须失败');
  for (const banned of ['授权', '供应商', '牌照', '暂不提供']) {
    assert.ok(!inHtml.includes(banned), `noscript 不得含「${banned}」`);
  }
});

test('mock 数据只在开发模式装配（生产不得有前端演示放行）', () => {
  const indexSource = readFileSync(join(SRC_DIR, 'data', 'index.ts'), 'utf8');
  assert.ok(indexSource.includes('import.meta.env.DEV'), 'mock 装配必须带 DEV 守卫');
});

test('403 与 EntitlementNotice 共用同一份文案，且 403 不提供重试（H3）', () => {
  const status403 = errorCopy(403, false);
  assert.equal(status403.title, copy.entitlement.title);
  assert.equal(status403.message, copy.entitlement.body);
  assert.equal(status403.hint, copy.entitlement.hint);
  assert.equal(status403.retry, null, '403 是确定状态，不暗示可恢复');
});

test('copy 版本轴：快照文件名为 <version>.<hash12>.frontend.json，且与 manifest 互相引用（ADR-006 D2/D3）', () => {
  const snapshotDir = join(H5_DIR, '..', '..', 'docs', 'release', 'copy-snapshots');
  const files = readdirSync(snapshotDir).filter(
    (name) => name.startsWith(`${COPY_VERSION}.`) && name.endsWith('.frontend.json'),
  );
  assert.equal(files.length, 1, '同一版本只允许一个 frontend 快照（append-only，不覆盖）');
  const fileName = files[0] ?? '';
  assert.match(fileName, new RegExp(`^${COPY_VERSION.replaceAll('.', '\\.')}\\.[a-f0-9]{12}\\.frontend\\.json$`));

  const snapshot = JSON.parse(readFileSync(join(snapshotDir, fileName), 'utf8')) as {
    version?: string;
    side?: string;
    hash?: string;
    strings?: string[];
  };
  assert.equal(snapshot.version, COPY_VERSION);
  assert.equal(snapshot.side, 'frontend');
  assert.ok(Array.isArray(snapshot.strings) && snapshot.strings.length > 0);
  assert.ok(fileName.includes((snapshot.hash ?? '').slice(0, 12)), '文件名必须含 hash 前 12 位');

  const manifestText = readFileSync(
    join(H5_DIR, '..', '..', 'docs', 'release', 'copy-version-manifest.md'),
    'utf8',
  );
  // append-only：同版本可能有多行（每次发版追加一行），取登记了当前 hash 的那一行；
  // 全部未命中时取最后一行，失败信息更有指向性（不会误取历史行）。
  const sameVersionRows = manifestText
    .split('\n')
    .filter((line) => line.split('|').map((cell) => cell.trim()).includes(COPY_VERSION));
  assert.ok(sameVersionRows.length > 0, `manifest 缺少 ${COPY_VERSION} 行（前后端成对登记）`);
  const row = sameVersionRows.find((line) => line.includes(snapshot.hash ?? '')) ?? sameVersionRows.at(-1) ?? '';
  assert.ok(row?.includes(snapshot.hash ?? ''), 'manifest 该行未登记当前 frontend hash');
  assert.ok(row?.includes(fileName), 'manifest 该行未记录当前 frontend 快照文件名');

  // manifest 行内引用的后端快照文件必须真实存在（回指不断链）。
  const backendRefs =
    row?.match(new RegExp(`${COPY_VERSION.replaceAll('.', '\\.')}\\.[a-f0-9]+\\.backend\\.json`, 'g')) ?? [];
  for (const ref of backendRefs) {
    assert.ok(existsSync(join(snapshotDir, ref)), `manifest 引用的后端快照不存在：${ref}`);
  }
});
