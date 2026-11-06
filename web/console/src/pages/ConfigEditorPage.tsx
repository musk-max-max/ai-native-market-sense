import { useEffect, useMemo, useState } from 'react';
import {
  applyMergeResolutions,
  diffValues,
  formatConfigValue,
  threeWayMerge,
  type ConflictChoice,
} from '../domain/diff';
import { computeImpact, dangerConfirmWord, dangerDescription } from '../domain/impact';
import { findConfigItem } from '../domain/registry';
import type {
  Actor,
  ConfigState,
  ConfigValue,
  ConfigValues,
  Release,
  ValidationIssue,
} from '../domain/types';
import {
  ActorBadge,
  DataTable,
  DiffViewer,
  DoubleConfirm,
  EmptyState,
  FormField,
  LevelBadge,
  StatusBadge,
  type Column,
  type ConflictView,
} from '../design-system';
import { errorMessage } from '../lib/errors';
import { formatDateTime } from '../lib/format';
import type { ConsoleServices } from '../lib/services';
import { TESTIDS } from '../lib/testids';
import { useAsync } from '../lib/use-async';

export interface ConfigEditorPageProps {
  services: ConsoleServices;
  actor: Actor;
  itemId: string | null;
  onSelectItem: (itemId: string) => void;
  onPendingApprovalsChange: () => void;
}

/** 配置编辑器：四中台共用一套表单/表格/diff/状态机。 */
export function ConfigEditorPage({
  services,
  actor,
  itemId,
  onSelectItem,
  onPendingApprovalsChange,
}: ConfigEditorPageProps) {
  const itemsState = useAsync(() => services.list(), [services]);
  const summaries = itemsState.data ?? [];

  return (
    <>
      <section className="c-page-head">
        <div>
          <h2>配置编辑器</h2>
          <p className="c-page-desc">
            员工手动配置与 agent 调用走同一条链路：草稿 → 校验 → 审批 → 发布。提交前必须核对 before/after
            diff 与影响面。
          </p>
        </div>
      </section>

      <div className="c-split">
        <section className="c-card">
          <h3>可配置项</h3>
          {itemsState.loading ? <div className="c-muted">加载中…</div> : null}
          <div className="c-nav">
            {summaries.map((summary) => (
              <button
                key={summary.item.id}
                type="button"
                className="c-nav-item"
                aria-current={itemId === summary.item.id ? 'page' : undefined}
                onClick={() => onSelectItem(summary.item.id)}
                data-testid={TESTIDS.configItemSelect(summary.item.id)}
              >
                <span>{summary.item.title}</span>
                <span className="c-spacer" />
                <LevelBadge level={summary.item.level} />
              </button>
            ))}
          </div>
          <p className="c-forbidden-note">
            免责声明 / AI 标识 / as_of / 退订入口 / 风险提示 / 话术白名单为不可配项，不提供任何入口。
          </p>
        </section>

        <section className="c-card">
          {itemId ? (
            <ConfigItemEditor
              key={itemId}
              services={services}
              actor={actor}
              itemId={itemId}
              onPendingApprovalsChange={onPendingApprovalsChange}
            />
          ) : (
            <EmptyState title="请选择一个配置项" hint="锁定项不会出现在这里。" />
          )}
        </section>
      </div>
    </>
  );
}

function ConfigItemEditor({
  services,
  actor,
  itemId,
  onPendingApprovalsChange,
}: {
  services: ConsoleServices;
  actor: Actor;
  itemId: string;
  onPendingApprovalsChange: () => void;
}) {
  const detailState = useAsync(() => services.get(itemId), [services, itemId]);
  const detail = detailState.data;
  const item = detail?.item ?? findConfigItem(itemId);

  const [values, setValues] = useState<ConfigValues>({});
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [draftState, setDraftState] = useState<ConfigState>('draft');
  const [message, setMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [conflict, setConflict] = useState<ConflictView | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ConflictChoice>>({});
  const [rollbackTarget, setRollbackTarget] = useState<Release | null>(null);

  useEffect(() => {
    if (!detail) return;
    setValues(detail.draft?.values ?? detail.published.values);
    setDraftState(detail.draft?.state ?? 'draft');
    setIssues([]);
    setConflict(null);
    setConflictVersion(null);
    setResolutions({});
    setShowDiff(false);
    setAcknowledged(false);
  }, [detail]);

  const before = detail?.published.values ?? {};
  const diffs = useMemo(
    () => (item ? diffValues(item.fields, before, values) : []),
    [item, before, values],
  );
  const impacts = useMemo(
    () => (item ? computeImpact(item.fields, diffs, item.level) : []),
    [item, diffs],
  );

  if (detailState.loading && !detail) return <div className="c-muted">加载中…</div>;
  if (detailState.error) return <div className="c-alert is-danger">{detailState.error}</div>;
  if (!detail || !item) return <EmptyState title="找不到配置项" />;

  const locked = draftState === 'pending_approval';
  const expectedVersion = detail.draft?.baseVersion ?? detail.publishedVersion;

  async function handleSave(): Promise<void> {
    setBusy(true);
    setErrorText(null);
    setMessage(null);
    try {
      const outcome = await services.saveDraft({
        itemId,
        expectedVersion,
        values,
        actor,
      });
      if (!outcome.ok) {
        if (outcome.kind === 'conflict') {
          setConflict({
            base: outcome.conflict.base,
            mine: outcome.conflict.mine,
            theirs: outcome.conflict.theirs,
          });
          setConflictVersion(outcome.conflict.currentVersion);
          setMessage(outcome.conflict.message);
          setShowDiff(true);
        } else if (outcome.kind === 'invalid') {
          setIssues(outcome.issues);
          setErrorText('草稿有校验错误，请修正后重试。');
        } else {
          setErrorText(outcome.message);
        }
        return;
      }
      setIssues(outcome.issues);
      setDraftState(outcome.draft.state);
      setMessage('草稿已保存。下一步：校验 → 查看 diff → 提交审批。');
    } catch (error) {
      setErrorText(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleValidate(): Promise<void> {
    setBusy(true);
    setErrorText(null);
    setMessage(null);
    try {
      const outcome = await services.validate(itemId, actor);
      setIssues(outcome.issues);
      setDraftState(outcome.state);
      setMessage(outcome.ok ? '校验通过，可以提交审批。' : '校验未通过，请修正红色字段后重新校验。');
    } catch (error) {
      setErrorText(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function handleOpenDiff(): void {
    setAcknowledged(false);
    setShowDiff(true);
  }

  async function handleDiffSubmit(): Promise<void> {
    if (!detail || !item) return;
    setBusy(true);
    setErrorText(null);
    try {
      if (conflict) {
        const rows = threeWayMerge(item.fields, conflict.base, conflict.mine, conflict.theirs);
        const merged = applyMergeResolutions(rows, resolutions, values);
        const outcome = await services.saveDraft({
          itemId,
          expectedVersion: conflictVersion ?? detail.publishedVersion,
          values: merged,
          actor,
        });
        if (!outcome.ok) {
          if (outcome.kind === 'conflict') {
            setConflict({
              base: outcome.conflict.base,
              mine: outcome.conflict.mine,
              theirs: outcome.conflict.theirs,
            });
            setConflictVersion(outcome.conflict.currentVersion);
            setMessage(outcome.conflict.message);
          } else if (outcome.kind === 'invalid') {
            setIssues(outcome.issues);
            setErrorText('合并后的草稿有校验错误，请修正。');
          } else {
            setErrorText(outcome.message);
          }
          return;
        }
        setValues(merged);
        setConflict(null);
        setConflictVersion(null);
        setResolutions({});
        setIssues(outcome.issues);
        setDraftState(outcome.draft.state);
        setShowDiff(false);
        setMessage('409 冲突已按你的选择合并并保存草稿，请重新校验后再提交审批。');
        return;
      }

      const changeRequest = await services.submitForApproval({
        itemId,
        actor,
        diffAcknowledged: true,
      });
      setMessage(`已提交审批：${changeRequest.id}（等待人类终审，agent 无终审权）`);
      setShowDiff(false);
      setAcknowledged(false);
      onPendingApprovalsChange();
      detailState.reload();
    } catch (error) {
      setErrorText(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRollback(): Promise<void> {
    if (!rollbackTarget) return;
    setBusy(true);
    setErrorText(null);
    try {
      await services.rollback({
        itemId,
        targetVersion: rollbackTarget.version,
        actor,
        diffAcknowledged: true,
        reason: `web/console 人工回滚到 v${rollbackTarget.version}`,
      });
      setMessage(`已回滚到 v${rollbackTarget.version}（追加新 release，历史保留）。`);
      setRollbackTarget(null);
      detailState.reload();
    } catch (error) {
      setErrorText(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const releaseColumns: Column<Release>[] = [
    { key: 'version', title: '版本', render: (release) => <span className="c-mono">v{release.version}</span> },
    {
      key: 'publishedAt',
      title: '发布时间',
      render: (release) => <span className="c-muted">{formatDateTime(release.publishedAt)}</span>,
    },
    { key: 'by', title: '发布者', render: (release) => <ActorBadge actor={release.publishedBy} /> },
    {
      key: 'authorization',
      title: '授权',
      render: (release) =>
        release.authorization.kind === 'human_approval' ? (
          <span>人类审批 · {release.authorization.approvalRef}</span>
        ) : (
          <span>规则自动 · {release.authorization.ruleVersion}</span>
        ),
    },
    {
      key: 'actions',
      title: '操作',
      render: (release) =>
        release.version === detail.publishedVersion ? (
          <span className="c-muted">当前版本</span>
        ) : (
          <button
            type="button"
            className="c-btn is-small"
            disabled={busy}
            onClick={() => setRollbackTarget(release)}
            data-testid={TESTIDS.releaseRow(release.releaseId)}
          >
            回滚到此版本
          </button>
        ),
    },
  ];

  const rollbackDiffs = rollbackTarget
    ? diffValues(item.fields, detail.published.values, rollbackTarget.values).filter(
        (row) => row.kind !== 'unchanged',
      )
    : [];

  return (
    <>
      <div className="c-page-head">
        <div>
          <h2 style={{ fontSize: 18 }}>{item.title}</h2>
          <p className="c-page-desc c-mono">{item.id}</p>
        </div>
        <div className="c-row">
          <LevelBadge level={item.level} />
          <StatusBadge state={draftState} />
          <span className="c-muted">线上 v{detail.publishedVersion}</span>
        </div>
      </div>

      {message ? <div className="c-alert is-success">{message}</div> : null}
      {errorText ? <div className="c-alert is-danger">{errorText}</div> : null}
      {locked ? (
        <div className="c-alert is-warning">
          草稿已提交审批（{detail.draft?.updatedBy.id} 提交），等待审批期间不能编辑。
        </div>
      ) : null}

      <form
        className="c-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
      >
        {item.fields.map((field) => (
          <FormField
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(next: ConfigValue) => setValues({ ...values, [field.key]: next })}
            issues={issues}
            disabled={busy || locked}
          />
        ))}

        <div className="c-diff-actions">
          <button
            type="button"
            className="c-btn"
            disabled={busy || locked}
            onClick={() => void handleValidate()}
            data-testid={TESTIDS.validateDraft}
          >
            校验草稿
          </button>
          <button
            type="button"
            className="c-btn"
            disabled={busy || locked}
            onClick={() => void handleSave()}
            data-testid={TESTIDS.saveDraft}
          >
            保存草稿
          </button>
          <button
            type="button"
            className="c-btn is-primary"
            disabled={busy || locked}
            onClick={handleOpenDiff}
            data-testid={TESTIDS.submitApproval}
          >
            查看 diff 并提交审批
          </button>
        </div>
      </form>

      {showDiff ? (
        <DiffViewer
          title={conflict ? '409 冲突：三点合并（base / mine / theirs）' : '变更预览（before / after）'}
          fields={item.fields}
          before={before}
          after={values}
          conflict={conflict}
          impacts={impacts}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
          resolutions={resolutions}
          onResolveConflict={(key, choice) => setResolutions({ ...resolutions, [key]: choice })}
          submitting={busy}
          submitLabel={conflict ? '按选择合并并保存草稿' : '确认并提交审批'}
          onSubmit={() => void handleDiffSubmit()}
          onCancel={() => setShowDiff(false)}
          errorText={errorText}
        />
      ) : null}

      <section style={{ marginTop: 'var(--space-4)' }}>
        <h3>发布历史（不可变 release）</h3>
        <DataTable
          columns={releaseColumns}
          rows={[...detail.releases].reverse()}
          rowKey={(release) => release.releaseId}
          emptyText="还没有发布记录"
        />
      </section>

      <DoubleConfirm
        open={rollbackTarget !== null}
        title={rollbackTarget ? `回滚「${item.title}」到 v${rollbackTarget.version}` : '回滚'}
        description={dangerDescription('rollback', item.title)}
        confirmWord={dangerConfirmWord('rollback')}
        impacts={
          rollbackTarget ? computeImpact(item.fields, rollbackDiffs, item.level) : []
        }
        detail={
          rollbackDiffs.length > 0 ? (
            <div className="c-table-wrap">
              <table className="c-table">
                <thead>
                  <tr>
                    <th scope="col">字段</th>
                    <th scope="col">当前线上</th>
                    <th scope="col">回滚到</th>
                  </tr>
                </thead>
                <tbody>
                  {rollbackDiffs.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td className="c-mono">{formatConfigValue(row.before)}</td>
                      <td className="c-mono">{formatConfigValue(row.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null
        }
        busy={busy}
        onCancel={() => setRollbackTarget(null)}
        onConfirm={() => void handleRollback()}
      />
    </>
  );
}
