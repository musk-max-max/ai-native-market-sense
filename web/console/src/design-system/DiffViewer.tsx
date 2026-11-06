import { useEffect, useMemo, useState } from 'react';
import type { ConfigFieldDef, ConfigValues, ImpactItem } from '../domain/types';
import {
  conflictRows,
  diffValues,
  formatConfigValue,
  summarizeDiff,
  threeWayMerge,
  type ConflictChoice,
  type DiffKind,
  type MergeResolution,
} from '../domain/diff';
import { ImpactPanel } from './ImpactPanel';
import { TESTIDS } from '../lib/testids';

export interface ConflictView {
  /** 客户端编辑时的基准（409 响应里的 base）。 */
  base: ConfigValues;
  /** 本次提交的草稿值。 */
  mine: ConfigValues;
  /** 服务端当前 published 值。 */
  theirs: ConfigValues;
}

export interface DiffViewerProps {
  title?: string;
  fields: readonly ConfigFieldDef[];
  /** 线上当前值（发布前最后一次 published）。 */
  before: ConfigValues;
  /** 拟发布的新值（草稿）。 */
  after: ConfigValues;
  /** 409 冲突时传入，启用三点 diff 合并。 */
  conflict?: ConflictView | null;
  impacts: readonly ImpactItem[];
  /** 必须核对 diff + 影响面后才允许提交（硬约束）。 */
  acknowledged: boolean;
  onAcknowledgedChange: (next: boolean) => void;
  /** 冲突字段的选择：mine | theirs。 */
  resolutions?: Readonly<Record<string, ConflictChoice>>;
  onResolveConflict?: (key: string, choice: ConflictChoice) => void;
  submitting?: boolean;
  submitLabel?: string;
  onSubmit: () => void;
  onCancel?: () => void;
  errorText?: string | null;
}

const DIFF_KIND_LABEL: Readonly<Record<DiffKind, string>> = {
  unchanged: '无变化',
  changed: '修改',
  added: '新增',
  removed: '移除',
};

const MERGE_LABEL: Readonly<Record<MergeResolution, string>> = {
  unchanged: '无变化',
  mine: '仅我修改',
  theirs: '仅线上修改',
  'same-change': '双方改成同值',
  conflict: '冲突',
};

type DiffMode = 'two-way' | 'three-way';

/**
 * before/after 差异查看器（中后台所有配置变更的唯一提交入口）。
 *
 * 两种模式：
 * - 两点：published（变更前）→ draft（变更后），用于正常提交；
 * - 三点：409 乐观锁冲突时 base / mine / theirs 三列，逐字段选择保留哪边。
 *
 * 门禁：未勾选「已核对 diff + 影响面」或仍有未决冲突时，提交按钮不可用；
 * 适配层还会二次校验，防绕过。
 */
export function DiffViewer({
  title = '变更预览',
  fields,
  before,
  after,
  conflict = null,
  impacts,
  acknowledged,
  onAcknowledgedChange,
  resolutions = {},
  onResolveConflict,
  submitting = false,
  submitLabel = '确认并提交审批',
  onSubmit,
  onCancel,
  errorText = null,
}: DiffViewerProps) {
  const [mode, setMode] = useState<DiffMode>('two-way');
  const [onlyChanged, setOnlyChanged] = useState(true);

  useEffect(() => {
    setMode(conflict ? 'three-way' : 'two-way');
  }, [conflict]);

  const twoWayRows = useMemo(() => diffValues(fields, before, after), [fields, before, after]);
  const mergeRows = useMemo(
    () => (conflict ? threeWayMerge(fields, conflict.base, conflict.mine, conflict.theirs) : []),
    [fields, conflict],
  );
  const summary = summarizeDiff(twoWayRows);
  const conflicts = conflictRows(mergeRows);
  const unresolved = conflicts.filter((row) => resolutions[row.key] === undefined).length;
  const canSubmit = acknowledged && unresolved === 0 && !submitting;

  const visibleTwoWay = onlyChanged
    ? twoWayRows.filter((row) => row.kind !== 'unchanged')
    : twoWayRows;
  const visibleMerge = onlyChanged
    ? mergeRows.filter((row) => row.resolution !== 'unchanged')
    : mergeRows;

  const changeCount = summary.changed + summary.added + summary.removed;

  return (
    <section className="c-diff" data-testid={TESTIDS.diffViewer}>
      <div className="c-diff-toolbar">
        <h3 style={{ margin: 0 }}>{title}</h3>
        {conflict ? (
          <button
            type="button"
            className="c-btn is-small"
            onClick={() => setMode(mode === 'two-way' ? 'three-way' : 'two-way')}
            data-testid={TESTIDS.diffModeToggle}
          >
            {mode === 'three-way' ? '切换两点对比' : '切换三点冲突合并'}
          </button>
        ) : null}
        <label className="c-row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onlyChanged}
            onChange={(event) => setOnlyChanged(event.target.checked)}
            data-testid={TESTIDS.diffOnlyChanges}
          />
          <span>仅看变更</span>
        </label>
        <span className="c-muted" data-testid="diff-summary">
          变更 {changeCount} · 新增 {summary.added} · 移除 {summary.removed} · 未变 {summary.unchanged}
        </span>
      </div>

      <div className="c-diff-legend">
        <span className="is-before">变更前（线上）</span>
        <span className="is-after">变更后（草稿）</span>
        {conflict ? <span className="is-conflict">冲突（需逐项选择）</span> : null}
      </div>

      {mode === 'three-way' && conflict ? (
        <table className="c-diff-table" data-testid="diff-three-way-table">
          <thead>
            <tr>
              <th scope="col">字段</th>
              <th scope="col">基线（编辑时 v）</th>
              <th scope="col">我的草稿</th>
              <th scope="col">线上当前</th>
              <th scope="col">冲突处理</th>
            </tr>
          </thead>
          <tbody>
            {visibleMerge.length === 0 ? (
              <tr>
                <td colSpan={5} className="c-diff-empty">
                  没有差异行。
                </td>
              </tr>
            ) : (
              visibleMerge.map((row) => {
                const choice = resolutions[row.key];
                return (
                  <tr
                    key={row.key}
                    className={row.resolution === 'conflict' ? 'is-conflict' : undefined}
                    data-testid={TESTIDS.diffRow(row.key)}
                  >
                    <td>
                      {row.label}
                      <div className="c-muted">{row.level}</div>
                    </td>
                    <td className="c-diff-value">{formatConfigValue(row.base)}</td>
                    <td className="c-diff-value">{formatConfigValue(row.mine)}</td>
                    <td className="c-diff-value">{formatConfigValue(row.theirs)}</td>
                    <td>
                      {row.resolution === 'conflict' ? (
                        <div className="c-diff-conflict-actions">
                          <button
                            type="button"
                            className={`c-btn is-small${choice === 'mine' ? ' is-chosen' : ''}`}
                            aria-pressed={choice === 'mine'}
                            onClick={() => onResolveConflict?.(row.key, 'mine')}
                            data-testid={TESTIDS.conflictChoiceMine(row.key)}
                          >
                            用我的
                          </button>
                          <button
                            type="button"
                            className={`c-btn is-small${choice === 'theirs' ? ' is-chosen' : ''}`}
                            aria-pressed={choice === 'theirs'}
                            onClick={() => onResolveConflict?.(row.key, 'theirs')}
                            data-testid={TESTIDS.conflictChoiceTheirs(row.key)}
                          >
                            用线上
                          </button>
                        </div>
                      ) : (
                        <span className="c-muted">{MERGE_LABEL[row.resolution]}</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      ) : (
        <table className="c-diff-table" data-testid="diff-two-way-table">
          <thead>
            <tr>
              <th scope="col">字段</th>
              <th scope="col">变更前（线上）</th>
              <th scope="col">变更后（草稿）</th>
              <th scope="col">类型</th>
            </tr>
          </thead>
          <tbody>
            {visibleTwoWay.length === 0 ? (
              <tr>
                <td colSpan={4} className="c-diff-empty">
                  没有字段变更。
                </td>
              </tr>
            ) : (
              visibleTwoWay.map((row) => (
                <tr key={row.key} className={`is-${row.kind}`} data-testid={TESTIDS.diffRow(row.key)}>
                  <td>
                    {row.label}
                    <div className="c-muted">{row.level}</div>
                  </td>
                  <td className="c-diff-value c-diff-before">{formatConfigValue(row.before)}</td>
                  <td className="c-diff-value c-diff-after">{formatConfigValue(row.after)}</td>
                  <td>{DIFF_KIND_LABEL[row.kind]}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      <ImpactPanel impacts={impacts} />

      {conflict && unresolved > 0 ? (
        <div className="c-alert is-warning">
          仍有 {unresolved} 个字段冲突未解决，解决后才能提交。
        </div>
      ) : null}

      <label className="c-diff-ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
          data-testid={TESTIDS.diffAck}
        />
        <span>我已核对以上 before/after diff 与影响范围，确认提交（会进入审批状态机，不能跳步）。</span>
      </label>

      {errorText ? (
        <div className="c-alert is-danger" role="alert">
          {errorText}
        </div>
      ) : null}

      <div className="c-diff-actions">
        {onCancel ? (
          <button type="button" className="c-btn" onClick={onCancel} data-testid={TESTIDS.diffCancel}>
            取消
          </button>
        ) : null}
        <button
          type="button"
          className="c-btn is-primary"
          disabled={!canSubmit}
          onClick={onSubmit}
          data-testid={TESTIDS.diffSubmit}
          title={!acknowledged ? '请先勾选已核对 diff' : unresolved > 0 ? '存在未解决冲突' : undefined}
        >
          {submitting ? '提交中…' : submitLabel}
        </button>
      </div>
    </section>
  );
}
