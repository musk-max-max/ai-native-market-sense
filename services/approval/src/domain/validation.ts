/**
 * OpsConfigWrite 结构校验 + 语义校验 V-01–V-10（configs/ops/schema/field-catalog.md §8）。
 *
 * - 结构错误与语义错误分列返回（validateOpsConfig 契约：valid=false 仍 HTTP 200）；
 * - 结构真源 = contracts/config/openapi.yaml（JSON Schema 2020-12 语义，手写展开以带 path/code）；
 * - V-05 路由白名单真源 = web/h5/src/lib/router.tsx parseRoute（A7）；默认拒绝；7 例对应锁定测试见 test/route-whitelist.test.ts（L165），正式化文档化清单仍待 A7/H2 签署；
 * - V-08 口径真源 = docs/metrics/p0_metrics.json（H4-D6）：可执行 M01/M02/M04/M08，M03/M05/M06/M07 pending-data；
 * - V-09/V-10 禁用词预检 = rules/ai-content-policy.json 全部 12 类 patterns（A5 真源），预检通过 ≠ 已批准。
 * V-11/V-12（发布时）与 V-13（query environment）在服务层/路由层硬校验。
 */

import { loadPolicy } from './evaluation.js';
import { sha256Ref, canonicalJson } from './canonical.js';
import type { ValidationIssue, OpsSpec } from './types.js';

const SYSTEM_FIELDS = ['version', 'status', 'meta'] as const;

const PATTERNS = {
  config_id: /^ops_[a-z0-9_]{3,48}$/,
  column_id: /^[a-z][a-z0-9_]{2,31}$/,
  content_item_id: /^ci_[a-z0-9_]{3,40}$/,
  strategy_id: /^st_[a-z0-9_]{2,32}$/,
  metric_id: /^M[0-9]{2}$/,
  content_ref: /^cnt_[a-z0-9_]{6,40}$/,
  asset_ref: /^ast_[a-z0-9_]{6,40}$/,
  target_route: /^\/(?:[a-z0-9_-]+)(?:\/[a-z0-9_{}-]+)*$/,
} as const;

const IMPACT_SCOPES = ['column_layout', 'content_copy', 'content_placement', 'ranking', 'rotation', 'visibility'] as const;
const ITEM_KINDS = ['editorial', 'data_card', 'banner'] as const;
const STRATEGY_TYPES = ['ranking', 'rotation'] as const;
const UNIVERSES = ['all_a', 'main_board'] as const;
const WINDOWS = ['d1', 'd5', 'd20'] as const;
const SCHEDULES = ['eod', 'manual'] as const;

/** V-08：H4 已签署且 executable 的口径（docs/metrics/p0_metrics.json，decision H4-D6）。 */
const EXECUTABLE_METRICS = new Set(['M01', 'M02', 'M04', 'M08']);
/** window 支持矩阵无独立真源，可执行口径暂全窗口支持（TODO H4 签署逐口径矩阵）。 */
const METRIC_WINDOWS = new Set(WINDOWS);

/**
 * V-05 A7 路由白名单（web/h5/src/lib/router.tsx parseRoute，2026-11-06 抽取）。
 * L165 单测锁定：test/route-whitelist.test.ts（7 例）；正式化文档化清单仍待 A7/H2 签署。模板 {segment} 匹配任意单段。
 */
const ROUTE_WHITELIST: readonly string[][] = [
  ['watchlist'],
  ['review', 'portfolio'],
  ['review', 'limits'],
  ['ai'],
  ['me'],
  ['stock', '{instrument_id}'],
  ['stocks', '{instrument_id}'],
];

/** T3 文案字段（field-catalog §7）：这 6 个字段走 T3 + H3 过审，全部进禁用词预检。 */
const T3_FIELDS: readonly string[] = [
  '/spec/columns/{i}/title',
  '/spec/columns/{i}/subtitle',
  '/spec/content_items/{i}/display_title',
  '/spec/content_items/{i}/summary',
  '/spec/strategies/{i}/metric_label',
  '/spec/strategies/{i}/title_template',
];

const MESSAGES: Record<string, string> = {
  required: '必填字段缺失',
  type: '字段类型错误',
  enum: '枚举值不在允许集合内',
  const: '常量值不符',
  pattern: '格式不符合要求',
  min_length: '长度低于下限',
  max_length: '长度超过上限',
  minimum: '数值低于下限',
  maximum: '数值超过上限',
  min_items: '数组元素数量低于下限',
  max_items: '数组元素数量超过上限',
  unique_items: '数组元素重复',
  additional_property: '不允许的未知字段',
  INVALID_SYSTEM_FIELD: '系统只读字段，不允许出现在请求体',
  'V-01': '集合内 id 重复',
  'V-02': 'columns[].order 集内重复',
  'V-03': 'content_items[].column_id 不存在于本集 columns[].id',
  'V-04': '同一 column_id 内 content_items[].order 重复',
  'V-05': 'target_route 未命中 A7 路由白名单',
  'V-06': 'display_window 必须 start_at < end_at 且带 +08:00 偏移',
  'V-07': '策略 id 集内重复',
  'V-08': 'metric_id 不是 H4 已签署可执行口径，或 window 不被该口径支持',
  'V-09': 'title_template 缺少 {metric_label} 与 {as_of} 占位符，或命中禁用词',
  'V-10': '对外文案命中禁用词预检',
};

function issue(path: string, code: string): ValidationIssue {
  return { path, code, message: MESSAGES[code] ?? code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isDateLike(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export interface ValidateResult {
  readonly structural: ValidationIssue[];
  readonly semantic: ValidationIssue[];
}

function checkUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  basePath: string,
  out: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      out.push(issue(basePath + '/' + key, 'additional_property'));
    }
  }
}

function checkStr(
  value: unknown,
  path: string,
  out: ValidationIssue[],
  opts: { pattern?: RegExp; min?: number; max?: number },
): boolean {
  if (typeof value !== 'string') {
    out.push(issue(path, 'type'));
    return false;
  }
  if (opts.pattern !== undefined && !opts.pattern.test(value)) {
    out.push(issue(path, 'pattern'));
    return false;
  }
  if (opts.min !== undefined && value.length < opts.min) {
    out.push(issue(path, 'min_length'));
    return false;
  }
  if (opts.max !== undefined && value.length > opts.max) {
    out.push(issue(path, 'max_length'));
    return false;
  }
  return true;
}

function checkInt(
  value: unknown,
  path: string,
  out: ValidationIssue[],
  opts: { min?: number; max?: number },
): boolean {
  if (!isInt(value)) {
    out.push(issue(path, 'type'));
    return false;
  }
  if (opts.min !== undefined && value < opts.min) {
    out.push(issue(path, 'minimum'));
    return false;
  }
  if (opts.max !== undefined && value > opts.max) {
    out.push(issue(path, 'maximum'));
    return false;
  }
  return true;
}

function checkEnum(value: unknown, path: string, allowed: readonly string[], out: ValidationIssue[]): boolean {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    out.push(issue(path, 'enum'));
    return false;
  }
  return true;
}

function validateColumn(raw: unknown, path: string, out: ValidationIssue[]): void {
  if (!isRecord(raw)) {
    out.push(issue(path, 'type'));
    return;
  }
  checkUnknownKeys(raw, ['id', 'title', 'subtitle', 'order', 'visible', 'max_items'], path, out);
  if ('id' in raw) checkStr(raw['id'], `${path}/id`, out, { pattern: PATTERNS.column_id });
  else out.push(issue(`${path}/id`, 'required'));
  if ('title' in raw) checkStr(raw['title'], `${path}/title`, out, { min: 1, max: 20 });
  else out.push(issue(`${path}/title`, 'required'));
  if ('subtitle' in raw) checkStr(raw['subtitle'], `${path}/subtitle`, out, { min: 1, max: 40 });
  if ('order' in raw) checkInt(raw['order'], `${path}/order`, out, { min: 0, max: 999 });
  else out.push(issue(`${path}/order`, 'required'));
  if ('visible' in raw && typeof raw['visible'] !== 'boolean') out.push(issue(`${path}/visible`, 'type'));
  if ('max_items' in raw) checkInt(raw['max_items'], `${path}/max_items`, out, { min: 1, max: 50 });
}

function validateDisplayWindow(raw: unknown, path: string, out: ValidationIssue[]): void {
  if (!isRecord(raw)) {
    out.push(issue(path, 'type'));
    return;
  }
  checkUnknownKeys(raw, ['start_at', 'end_at', 'timezone'], path, out);
  if ('start_at' in raw) {
    if (!isDateLike(raw['start_at'])) out.push(issue(`${path}/start_at`, 'type'));
  } else out.push(issue(`${path}/start_at`, 'required'));
  if ('end_at' in raw) {
    if (!isDateLike(raw['end_at'])) out.push(issue(`${path}/end_at`, 'type'));
  } else out.push(issue(`${path}/end_at`, 'required'));
  if ('timezone' in raw && raw['timezone'] !== 'Asia/Shanghai') {
    out.push(issue(`${path}/timezone`, 'const'));
  }
}

function validateContentItem(raw: unknown, path: string, out: ValidationIssue[]): void {
  if (!isRecord(raw)) {
    out.push(issue(path, 'type'));
    return;
  }
  checkUnknownKeys(
    raw,
    ['id', 'kind', 'column_id', 'order', 'visible', 'content_ref', 'asset_ref', 'display_title', 'summary', 'target_route', 'display_window'],
    path,
    out,
  );
  if ('id' in raw) checkStr(raw['id'], `${path}/id`, out, { pattern: PATTERNS.content_item_id });
  else out.push(issue(`${path}/id`, 'required'));
  if ('kind' in raw) checkEnum(raw['kind'], `${path}/kind`, ITEM_KINDS, out);
  else out.push(issue(`${path}/kind`, 'required'));
  if ('column_id' in raw) checkStr(raw['column_id'], `${path}/column_id`, out, { pattern: PATTERNS.column_id });
  else out.push(issue(`${path}/column_id`, 'required'));
  if ('order' in raw) checkInt(raw['order'], `${path}/order`, out, { min: 0, max: 999 });
  else out.push(issue(`${path}/order`, 'required'));
  if ('visible' in raw && typeof raw['visible'] !== 'boolean') out.push(issue(`${path}/visible`, 'type'));
  if ('content_ref' in raw) checkStr(raw['content_ref'], `${path}/content_ref`, out, { pattern: PATTERNS.content_ref });
  if ('asset_ref' in raw) checkStr(raw['asset_ref'], `${path}/asset_ref`, out, { pattern: PATTERNS.asset_ref });
  if ('display_title' in raw) checkStr(raw['display_title'], `${path}/display_title`, out, { min: 1, max: 30 });
  if ('summary' in raw) checkStr(raw['summary'], `${path}/summary`, out, { min: 1, max: 80 });
  if ('target_route' in raw) checkStr(raw['target_route'], `${path}/target_route`, out, { pattern: PATTERNS.target_route });
  if ('display_window' in raw) validateDisplayWindow(raw['display_window'], `${path}/display_window`, out);
}

function validateStrategy(raw: unknown, path: string, out: ValidationIssue[]): void {
  if (!isRecord(raw)) {
    out.push(issue(path, 'type'));
    return;
  }
  const type = raw['type'];
  if (type === 'ranking') {
    checkUnknownKeys(
      raw,
      ['type', 'id', 'metric_id', 'metric_label', 'universe', 'window', 'limit', 'title_template', 'schedule', 'personalized', 'enabled'],
      path,
      out,
    );
    if ('id' in raw) checkStr(raw['id'], `${path}/id`, out, { pattern: PATTERNS.strategy_id });
    else out.push(issue(`${path}/id`, 'required'));
    if ('metric_id' in raw) checkStr(raw['metric_id'], `${path}/metric_id`, out, { pattern: PATTERNS.metric_id });
    else out.push(issue(`${path}/metric_id`, 'required'));
    if ('metric_label' in raw) checkStr(raw['metric_label'], `${path}/metric_label`, out, { min: 1, max: 12 });
    else out.push(issue(`${path}/metric_label`, 'required'));
    if ('universe' in raw) checkEnum(raw['universe'], `${path}/universe`, UNIVERSES, out);
    else out.push(issue(`${path}/universe`, 'required'));
    if ('window' in raw) checkEnum(raw['window'], `${path}/window`, WINDOWS, out);
    else out.push(issue(`${path}/window`, 'required'));
    if ('limit' in raw) checkInt(raw['limit'], `${path}/limit`, out, { min: 1, max: 50 });
    else out.push(issue(`${path}/limit`, 'required'));
    if ('title_template' in raw) checkStr(raw['title_template'], `${path}/title_template`, out, { min: 4, max: 40 });
    else out.push(issue(`${path}/title_template`, 'required'));
    if ('schedule' in raw) checkEnum(raw['schedule'], `${path}/schedule`, SCHEDULES, out);
    if ('personalized' in raw && raw['personalized'] !== false) out.push(issue(`${path}/personalized`, 'const'));
    else if (!('personalized' in raw)) out.push(issue(`${path}/personalized`, 'required'));
    if ('enabled' in raw && typeof raw['enabled'] !== 'boolean') out.push(issue(`${path}/enabled`, 'type'));
    return;
  }
  if (type === 'rotation') {
    checkUnknownKeys(raw, ['type', 'id', 'max_items', 'interval_seconds', 'enabled'], path, out);
    if ('id' in raw) checkStr(raw['id'], `${path}/id`, out, { pattern: PATTERNS.strategy_id });
    else out.push(issue(`${path}/id`, 'required'));
    if ('max_items' in raw) checkInt(raw['max_items'], `${path}/max_items`, out, { min: 1, max: 20 });
    else out.push(issue(`${path}/max_items`, 'required'));
    if ('interval_seconds' in raw) checkInt(raw['interval_seconds'], `${path}/interval_seconds`, out, { min: 3, max: 30 });
    else out.push(issue(`${path}/interval_seconds`, 'required'));
    if ('enabled' in raw && typeof raw['enabled'] !== 'boolean') out.push(issue(`${path}/enabled`, 'type'));
    return;
  }
  out.push(issue(`${path}/type`, 'enum'));
}

/** V-05：A7 路由白名单（模板段 {x} 通配单段），默认拒绝。 */
export function isRouteAllowed(targetRoute: string): boolean {
  const segments = targetRoute.split('/').filter((part) => part.length > 0);
  return ROUTE_WHITELIST.some(
    (template) =>
      template.length === segments.length &&
      template.every((segment, i) => segment.startsWith('{') ? (segments[i] ?? '').length > 0 : segment === segments[i]),
  );
}

/** 禁用词预检（V-09/V-10）：rules/ai-content-policy.json 12 类 patterns 全量扫描。 */
export function bannedWordHits(text: string): string[] {
  const policy = loadPolicy();
  const hits: string[] = [];
  for (const category of policy.categories) {
    for (const pattern of category.patterns) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        // 策略正则不可编译 ⇒ fail-closed 记为命中（H5 默认拒绝）。
        hits.push(`${category.id}:policy_pattern_invalid`);
        break;
      }
      if (re.test(text)) {
        hits.push(category.id);
        break;
      }
    }
  }
  return hits;
}

/**
 * 结构校验 + 语义校验 V-01–V-10。
 * @param body 解析后的 OpsConfigWrite（未信任输入）
 * @param queryEnvironment 路径 query environment（V-13 由调用方硬校验后传入，此处只校 body.environment 枚举）
 */
export function validateOpsWrite(body: unknown, _queryEnvironment: string): ValidateResult {
  const structural: ValidationIssue[] = [];
  const semantic: ValidationIssue[] = [];

  if (!isRecord(body)) {
    structural.push(issue('', 'type'));
    return { structural, semantic };
  }

  // 系统只读字段：请求体携带即 INVALID_SYSTEM_FIELD（contracts/config SystemMeta 描述）。
  for (const key of SYSTEM_FIELDS) {
    if (key in body) {
      structural.push(issue('/' + key, 'INVALID_SYSTEM_FIELD'));
    }
  }
  checkUnknownKeys(body, ['schema_version', 'config_id', 'environment', 'change_reason', 'impact_scope', 'spec'], '', structural);

  if ('schema_version' in body && body['schema_version'] !== '0.1') {
    structural.push(issue('/schema_version', 'const'));
  } else if (!('schema_version' in body)) {
    structural.push(issue('/schema_version', 'required'));
  }
  if ('config_id' in body) {
    if (!PATTERNS.config_id.test(String(body['config_id']))) structural.push(issue('/config_id', 'pattern'));
  } else {
    structural.push(issue('/config_id', 'required'));
  }
  if ('environment' in body) checkEnum(body['environment'], '/environment', ['dev', 'staging', 'prod'], structural);
  else structural.push(issue('/environment', 'required'));
  if ('change_reason' in body) checkStr(body['change_reason'], '/change_reason', structural, { min: 8, max: 200 });
  else structural.push(issue('/change_reason', 'required'));

  if ('impact_scope' in body) {
    const scope = body['impact_scope'];
    if (!Array.isArray(scope)) {
      structural.push(issue('/impact_scope', 'type'));
    } else {
      if (scope.length < 1) structural.push(issue('/impact_scope', 'min_items'));
      if (scope.length > 6) structural.push(issue('/impact_scope', 'max_items'));
      if (new Set(scope.map((entry) => JSON.stringify(entry))).size !== scope.length) {
        structural.push(issue('/impact_scope', 'unique_items'));
      }
      scope.forEach((entry, i) => checkEnum(entry, `/impact_scope/${i}`, IMPACT_SCOPES, structural));
    }
  } else {
    structural.push(issue('/impact_scope', 'required'));
  }

  const specRaw = body['spec'];
  if (!isRecord(specRaw)) {
    structural.push(issue('/spec', 'required'));
    return { structural, semantic };
  }
  checkUnknownKeys(specRaw, ['columns', 'content_items', 'strategies'], '/spec', structural);
  const arrays: Record<'columns' | 'content_items' | 'strategies', unknown[]> = {
    columns: [],
    content_items: [],
    strategies: [],
  };
  for (const key of ['columns', 'content_items', 'strategies'] as const) {
    const value = specRaw[key];
    if (!Array.isArray(value)) {
      structural.push(issue(`/spec/${key}`, key in specRaw ? 'type' : 'required'));
      continue;
    }
    const max = key === 'columns' ? 20 : key === 'content_items' ? 100 : 10;
    if (value.length > max) structural.push(issue(`/spec/${key}`, 'max_items'));
    arrays[key] = value;
    value.forEach((entry, i) => {
      const path = `/spec/${key}/${i}`;
      if (key === 'columns') validateColumn(entry, path, structural);
      else if (key === 'content_items') validateContentItem(entry, path, structural);
      else validateStrategy(entry, path, structural);
    });
  }

  // ---- 语义 V-01–V-10（只在元素形状可判定时运行） ----
  const columns = arrays.columns.filter(isRecord);
  const items = arrays.content_items.filter(isRecord);
  const strategies = arrays.strategies.filter(isRecord);

  const dupIssue = (paths: string[], code: string): void => {
    for (const path of paths) semantic.push(issue(path, code));
  };

  // V-01 / V-07：各集合内 id 唯一。
  for (const [set, code] of [[columns, 'V-01'], [items, 'V-01'], [strategies, 'V-07']] as const) {
    const seen = new Map<string, string[]>();
    set.forEach((entry, i) => {
      const id = typeof entry['id'] === 'string' ? entry['id'] : null;
      if (id === null) return;
      const key = `${String(entry['type'] ?? '')}:${id}`;
      const list = seen.get(key) ?? [];
      list.push(`/spec/${set === columns ? 'columns' : set === items ? 'content_items' : 'strategies'}/${i}/id`);
      seen.set(key, list);
    });
    for (const paths of seen.values()) {
      if (paths.length > 1) dupIssue(paths, code);
    }
  }

  // V-02：columns[].order 集内唯一。
  {
    const seen = new Map<number, string[]>();
    columns.forEach((column, i) => {
      const order = column['order'];
      if (!isInt(order)) return;
      const list = seen.get(order) ?? [];
      list.push(`/spec/columns/${i}/order`);
      seen.set(order, list);
    });
    for (const paths of seen.values()) {
      if (paths.length > 1) dupIssue(paths, 'V-02');
    }
  }

  // V-03 + V-04：column_id 必须存在；同 column_id 内 order 唯一。
  const columnIds = new Set(columns.map((column) => column['id']).filter((id): id is string => typeof id === 'string'));
  {
    const orderByColumn = new Map<string, Map<number, string[]>>();
    items.forEach((item, i) => {
      const columnId = item['column_id'];
      if (typeof columnId !== 'string') return;
      if (!columnIds.has(columnId)) {
        semantic.push(issue(`/spec/content_items/${i}/column_id`, 'V-03'));
      }
      const order = item['order'];
      if (!isInt(order)) return;
      const perColumn = orderByColumn.get(columnId) ?? new Map<number, string[]>();
      const list = perColumn.get(order) ?? [];
      list.push(`/spec/content_items/${i}/order`);
      perColumn.set(order, list);
      orderByColumn.set(columnId, perColumn);
    });
    for (const perColumn of orderByColumn.values()) {
      for (const paths of perColumn.values()) {
        if (paths.length > 1) dupIssue(paths, 'V-04');
      }
    }
  }

  // V-05 / V-06：target_route 白名单；display_window +08:00 且 start < end。
  items.forEach((item, i) => {
    const route = item['target_route'];
    if (typeof route === 'string' && PATTERNS.target_route.test(route) && !isRouteAllowed(route)) {
      semantic.push(issue(`/spec/content_items/${i}/target_route`, 'V-05'));
    }
    const window = item['display_window'];
    if (isRecord(window)) {
      const start = window['start_at'];
      const end = window['end_at'];
      if (isDateLike(start) && isDateLike(end)) {
        const plus8 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?\+08:00$/;
        const startOk = plus8.test(start);
        const endOk = plus8.test(end);
        if (!startOk || !endOk || Date.parse(start) >= Date.parse(end)) {
          semantic.push(issue(`/spec/content_items/${i}/display_window`, 'V-06'));
        }
      }
    }
  });

  // V-08 / V-09 / V-10：口径可执行性 + title_template 占位符 + 禁用词预检。
  strategies.forEach((strategy, i) => {
    if (strategy['type'] !== 'ranking') return;
    const metricId = strategy['metric_id'];
    const window = strategy['window'];
    if (typeof metricId === 'string') {
      if (!EXECUTABLE_METRICS.has(metricId) || (typeof window === 'string' && !METRIC_WINDOWS.has(window as 'd1' | 'd5' | 'd20'))) {
        semantic.push(issue(`/spec/strategies/${i}/metric_id`, 'V-08'));
      }
    }
    const template = strategy['title_template'];
    if (typeof template === 'string') {
      if (!template.includes('{metric_label}') || !template.includes('{as_of}')) {
        semantic.push(issue(`/spec/strategies/${i}/title_template`, 'V-09'));
      } else if (bannedWordHits(template).length > 0) {
        semantic.push(issue(`/spec/strategies/${i}/title_template`, 'V-09'));
      }
    }
    for (const field of ['metric_label'] as const) {
      const text = strategy[field];
      if (typeof text === 'string' && bannedWordHits(text).length > 0) {
        semantic.push(issue(`/spec/strategies/${i}/${field}`, 'V-10'));
      }
    }
  });
  columns.forEach((column, i) => {
    for (const field of ['title', 'subtitle'] as const) {
      const text = column[field];
      if (typeof text === 'string' && bannedWordHits(text).length > 0) {
        semantic.push(issue(`/spec/columns/${i}/${field}`, 'V-10'));
      }
    }
  });
  items.forEach((item, i) => {
    for (const field of ['display_title', 'summary'] as const) {
      const text = item[field];
      if (typeof text === 'string' && bannedWordHits(text).length > 0) {
        semantic.push(issue(`/spec/content_items/${i}/${field}`, 'V-10'));
      }
    }
  });

  return { structural, semantic };
}

/** 校验报告（validateOpsConfig：valid=false 仍 HTTP 200）。 */
export function toValidationReport(result: ValidateResult, spec: OpsSpec | null): {
  valid: boolean;
  structural_errors: ValidationIssue[];
  semantic_errors: ValidationIssue[];
  normalized_hash?: string;
} {
  const valid = result.structural.length === 0 && result.semantic.length === 0;
  return {
    valid,
    structural_errors: result.structural,
    semantic_errors: result.semantic,
    ...(spec !== null ? { normalized_hash: sha256Ref(canonicalJson(spec)) } : {}),
  };
}

export { T3_FIELDS };
