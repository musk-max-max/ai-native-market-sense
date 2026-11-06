/**
 * 三点 diff（contracts/config ThreeWayDiff/FieldChange/FieldConflict）：
 * base vs current（服务端现版本）vs submitted（提交内容/第三版本），JSON Pointer 粒度。
 */

import type { DiffValue, FieldChange, FieldConflict, ThreeWayDiff } from './types.js';

/** 叶子级展平：对象递归、数组按索引递归、原始值与空容器为叶；path 为 JSON Pointer。 */
export function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.set(prefix, value);
      return out;
    }
    for (const [key, child] of entries) {
      for (const [path, leaf] of flatten(child, `${prefix}/${key}`)) {
        out.set(path, leaf);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix, value);
      return out;
    }
    value.forEach((child, i) => {
      for (const [path, leaf] of flatten(child, `${prefix}/${i}`)) {
        out.set(path, leaf);
      }
    });
    return out;
  }
  out.set(prefix, value);
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export interface ThreeWayInput {
  readonly configId: string;
  readonly environment: string;
  readonly baseVersion: number;
  readonly currentVersion: number;
  readonly submittedVersion: number;
  readonly base: unknown;
  readonly current: unknown;
  readonly submitted: unknown;
}

export function threeWayDiff(input: ThreeWayInput): ThreeWayDiff {
  const base = flatten(input.base);
  const current = flatten(input.current);
  const submitted = flatten(input.submitted);
  const paths = new Set([...base.keys(), ...current.keys(), ...submitted.keys()]);
  const changes: FieldChange[] = [];
  const conflicts: FieldConflict[] = [];

  for (const path of [...paths].sort()) {
    const inBase = base.has(path);
    const inCurrent = current.has(path);
    const inSubmitted = submitted.has(path);
    const baseValue = base.get(path) ?? null;
    const currentValue = current.get(path) ?? null;
    const submittedValue = submitted.get(path) ?? null;

    const changedCurrent = !sameValue(inBase ? baseValue : null, inCurrent ? currentValue : null) || inBase !== inCurrent;
    const changedSubmitted = !sameValue(inBase ? baseValue : null, inSubmitted ? submittedValue : null) || inBase !== inSubmitted;
    if (!changedCurrent && !changedSubmitted) continue;

    const values: { base: DiffValue; current: DiffValue; submitted: DiffValue } = {
      base: inBase ? (baseValue as DiffValue) : null,
      current: inCurrent ? (currentValue as DiffValue) : null,
      submitted: inSubmitted ? (submittedValue as DiffValue) : null,
    };

    const divergent =
      (inSubmitted && !sameValue(submittedValue, inCurrent ? currentValue : null)) ||
      (inCurrent && !sameValue(currentValue, inSubmitted ? submittedValue : null)) ||
      inCurrent !== inSubmitted;

    if (changedCurrent && changedSubmitted && divergent) {
      let reason: FieldConflict['reason'];
      if (!inBase && inCurrent) reason = 'base_removed_current_modified';
      else if (inBase && !inCurrent) reason = 'base_modified_current_removed';
      else reason = 'both_modified';
      conflicts.push({ path, reason, ...values });
      continue;
    }

    let kind: FieldChange['kind'];
    if (!inBase && (inSubmitted || inCurrent)) kind = 'added';
    else if (inBase && !inSubmitted && !inCurrent) kind = 'removed';
    else if (inBase && (inSubmitted ? !inSubmitted : true) && !inCurrent) kind = 'removed';
    else kind = 'modified';
    if (inBase && !inSubmitted && inCurrent && !changedSubmitted) kind = 'removed';
    if (!inSubmitted && !inCurrent) kind = 'removed';
    if (!inBase && !inSubmitted && inCurrent) kind = 'added';
    changes.push({ path, kind, ...values });
  }

  return {
    config_id: input.configId,
    environment: input.environment as ThreeWayDiff['environment'],
    base_version: input.baseVersion,
    current_version: input.currentVersion,
    submitted_version: input.submittedVersion,
    changes,
    conflicts,
  };
}
