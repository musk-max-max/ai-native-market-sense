import type { ConfigFieldDef, ConfigLevel, ConfigValue, ConfigValues } from './types';

/**
 * 配置 diff（决策 #6：before/after + 409 冲突时三点 diff）。
 *
 * 两点 diff：published（before）→ 草稿（after），行分 unchanged/changed/added/removed。
 * 三点 diff：base（草稿导入时的 published）· mine（我的草稿）· theirs（服务端当前 published），
 * 用于乐观锁 409 冲突：只有双方改了同一字段且值不同才判 conflict。
 */

export type DiffKind = 'unchanged' | 'changed' | 'added' | 'removed';

export interface FieldDiff {
  key: string;
  label: string;
  level: ConfigLevel;
  before: ConfigValue | undefined;
  after: ConfigValue | undefined;
  kind: DiffKind;
}

export function isUnset(value: ConfigValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

export function valuesEqual(a: ConfigValue | undefined, b: ConfigValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return false;
}

/** 值 → 可读文本（DiffViewer/审计共用；不做 HTML）。 */
export function formatConfigValue(value: ConfigValue | undefined): string {
  if (value === undefined) return '未设置';
  if (value === null) return '未设置';
  if (Array.isArray(value)) return value.length === 0 ? '（空列表）' : value.join('、');
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '非法数值';
  if (typeof value === 'string') return value === '' ? '（空）' : value;
  return value.join('、');
}

export function diffValues(
  fields: readonly ConfigFieldDef[],
  before: ConfigValues,
  after: ConfigValues,
): FieldDiff[] {
  return fields.map((field) => {
    const from = before[field.key];
    const to = after[field.key];
    let kind: DiffKind;
    if (valuesEqual(from, to)) {
      kind = 'unchanged';
    } else if (isUnset(from) && !isUnset(to)) {
      kind = 'added';
    } else if (!isUnset(from) && isUnset(to)) {
      kind = 'removed';
    } else {
      kind = 'changed';
    }
    return {
      key: field.key,
      label: field.label,
      level: field.level,
      before: from,
      after: to,
      kind,
    };
  });
}

export interface DiffSummary {
  total: number;
  changed: number;
  added: number;
  removed: number;
  unchanged: number;
}

export function summarizeDiff(rows: readonly FieldDiff[]): DiffSummary {
  const summary: DiffSummary = { total: rows.length, changed: 0, added: 0, removed: 0, unchanged: 0 };
  for (const row of rows) {
    summary[row.kind] += 1;
  }
  return summary;
}

export type MergeResolution = 'unchanged' | 'mine' | 'theirs' | 'same-change' | 'conflict';

export interface MergeRow {
  key: string;
  label: string;
  level: ConfigLevel;
  base: ConfigValue | undefined;
  mine: ConfigValue | undefined;
  theirs: ConfigValue | undefined;
  resolution: MergeResolution;
}

/**
 * 三点合并判定：
 * - mine === theirs               → unchanged（含双方都没改、双方改成同值）
 * - base === mine（只有对方改）    → theirs
 * - base === theirs（只有我改）    → mine
 * - 其余（双方改成不同值）         → conflict
 * 另标 same-change 便于界面展示「双方改成了同一个值」。
 */
export function threeWayMerge(
  fields: readonly ConfigFieldDef[],
  base: ConfigValues,
  mine: ConfigValues,
  theirs: ConfigValues,
): MergeRow[] {
  return fields.map((field) => {
    const b = base[field.key];
    const m = mine[field.key];
    const t = theirs[field.key];

    let resolution: MergeResolution;
    if (valuesEqual(m, t)) {
      if (valuesEqual(b, m)) resolution = 'unchanged';
      else if (isUnset(b) && isUnset(m)) resolution = 'unchanged';
      else resolution = 'same-change';
    } else if (valuesEqual(b, m)) {
      resolution = 'theirs';
    } else if (valuesEqual(b, t)) {
      resolution = 'mine';
    } else {
      resolution = 'conflict';
    }

    return { key: field.key, label: field.label, level: field.level, base: b, mine: m, theirs: t, resolution };
  });
}

export function conflictRows(rows: readonly MergeRow[]): MergeRow[] {
  return rows.filter((row) => row.resolution === 'conflict');
}

export type ConflictChoice = 'mine' | 'theirs';

/**
 * 把三点 diff 的冲突选择合并成最终值：
 * - unchanged / mine / same-change → 取 mine
 * - theirs（只有线上改过）→ 取 theirs
 * - conflict 行按选择覆盖（mine 取我的、theirs 取线上的）
 * - 仍有冲突未决 → 抛错（前端门禁 + 适配层二次校验）
 */
export function applyMergeResolutions(
  rows: readonly MergeRow[],
  resolutions: Readonly<Record<string, ConflictChoice>>,
  mine: ConfigValues,
): ConfigValues {
  const merged: Record<string, ConfigValue> = { ...mine };
  const unresolved: string[] = [];
  for (const row of rows) {
    if (row.resolution === 'conflict') {
      const choice = resolutions[row.key];
      if (choice === 'theirs') {
        merged[row.key] = row.theirs ?? null;
      } else if (choice === 'mine') {
        merged[row.key] = row.mine ?? null;
      } else {
        unresolved.push(row.key);
      }
    } else if (row.resolution === 'theirs') {
      merged[row.key] = row.theirs ?? null;
    }
  }
  if (unresolved.length > 0) {
    throw new UnresolvedConflictsError(unresolved);
  }
  return merged;
}

export class UnresolvedConflictsError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`仍有 ${keys.length} 个字段未解决冲突：${keys.join(', ')}`);
    this.name = 'UnresolvedConflictsError';
    this.keys = keys;
  }
}

/** 变更字段的中文摘要，用于审批单/审计 detail。 */
export function describeDiff(rows: readonly FieldDiff[], limit = 4): string {
  const changed = rows.filter((row) => row.kind !== 'unchanged');
  if (changed.length === 0) return '无字段变更';
  const head = changed.slice(0, limit).map((row) => `${row.label}（${row.kind}）`);
  const suffix = changed.length > limit ? ` 等 ${changed.length} 项` : '';
  return `${head.join('、')}${suffix}`;
}
