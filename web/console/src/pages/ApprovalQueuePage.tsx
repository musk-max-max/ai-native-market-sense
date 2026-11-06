import { useEffect, useState } from 'react';
import { diffValues } from '../domain/diff';
import { computeImpact, dangerConfirmWord, dangerDescription } from '../domain/impact';
import { findConfigItem } from '../domain/registry';
import type { Actor, ApprovalItemView, ChangeRequest } from '../domain/types';
import {
  ActorBadge,
  DataTable,
  DiffViewer,
  DoubleConfirm,
  EmptyState,
  LevelBadge,
  StatusBadge,
  type Column,
} from '../design-system';
import { errorMessage } from '../lib/errors';
import { formatDateTime } from '../lib/format';
import type { ConsoleServices } from '../lib/services';
import { TESTIDS } from '../lib/testids';
import { useAsync } from '../lib/use-async';

export interface ApprovalQueuePageProps {
  services: ConsoleServices;
  actor: Actor;
  onPendingApprovalsChange: () => void;
}

/**
 * 审批队列（管理后台）。
 * 单条审批是 API 约束：列表不提供任何批量通过/批量驳回入口。
 * agent 只能发起变更；终审必须是人类（C1=A：A15 只是调度员，低风险由规则引擎放行）。
 */
export function ApprovalQueuePage({ services, actor, onPendingApprovalsChange }: ApprovalQueuePageProps) {
  const listState = useAsync(() => services.listPending(), [services]);
  const views = listState.data ?? [];

  const [selectedId, setSelectedId] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [approvalRef, setApprovalRef] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (views.length === 0) {
      setSelectedId('');
      return;
    }
    if (!views.some((view) => view.changeRequest.id === selectedId)) {
      setSelectedId(views[0]?.changeRequest.id ?? '');
    }
  }, [views, selectedId]);

  const selected: ApprovalItemView | null =
    views.find((view) => view.changeRequest.id === selectedId) ?? null;

  useEffect(() => {
    setAcknowledged(false);
    setRejectReason('');
    setConfirmOpen(false);
    setApprovalRef(selectedId ? `console/${selectedId}` : '');
  }, [selectedId]);

  const item = selected ? findConfigItem(selected.changeRequest.itemId) : undefined;

  async function handleApproveAndPublish(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setErrorText(null);
    try {
      await services.approve({
        changeRequestId: selected.changeRequest.id,
        actor,
        approvalRef: approvalRef.trim(),
        diffAcknowledged: true,
      });
      await services.publish({
        itemId: selected.changeRequest.itemId,
        changeRequestId: selected.changeRequest.id,
        actor,
        diffAcknowledged: true,
      });
      setMessage(`已通过并发布：${selected.changeRequest.id}`);
      setConfirmOpen(false);
      setAcknowledged(false);
      onPendingApprovalsChange();
      listState.reload();
    } catch (error) {
      setErrorText(errorMessage(error));
      setConfirmOpen(false);
      listState.reload();
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setErrorText(null);
    try {
      await services.reject({
        changeRequestId: selected.changeRequest.id,
        actor,
        reason: rejectReason.trim(),
      });
      setMessage(`已驳回：${selected.changeRequest.id}`);
      onPendingApprovalsChange();
      listState.reload();
    } catch (error) {
      setErrorText(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<ApprovalItemView>[] = [
    {
      key: 'id',
      title: '变更单',
      render: (view) => <span className="c-mono">{view.changeRequest.id}</span>,
    },
    {
      key: 'title',
      title: '配置项',
      render: (view) => (
        <div>
          <div>{view.changeRequest.title}</div>
          <div className="c-mono c-muted">{view.changeRequest.itemId}</div>
        </div>
      ),
    },
    { key: 'level', title: '等级', render: (view) => <LevelBadge level={view.changeRequest.level} /> },
    { key: 'requester', title: '发起人', render: (view) => <ActorBadge actor={view.changeRequest.requester} /> },
    {
      key: 'at',
      title: '提交时间',
      render: (view) => <span className="c-muted">{formatDateTime(view.changeRequest.submittedAt)}</span>,
    },
    {
      key: 'state',
      title: '状态',
      render: (view) => <StatusBadge state={view.changeRequest.state} />,
    },
  ];

  const changeRequest: ChangeRequest | null = selected?.changeRequest ?? null;
  const approvalImpacts = selected
    ? selected.impact.length > 0
      ? selected.impact
      : item
        ? computeImpact(item.fields, diffValues(item.fields, selected.before, changeRequest?.values ?? {}), item.level)
        : []
    : [];

  return (
    <>
      <section className="c-page-head">
        <div>
          <h2>审批队列</h2>
          <p className="c-page-desc">
            单条审批（API 约束，不支持批量）。agent 发起的变更同样需要人类终审；审批人身份由服务端 identity
            校验，前端不做身份判定。
          </p>
        </div>
      </section>

      {message ? <div className="c-alert is-success">{message}</div> : null}
      {errorText ? <div className="c-alert is-danger">{errorText}</div> : null}

      <section className="c-card">
        <h3>待审批</h3>
        {listState.loading ? (
          <div className="c-muted">加载中…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={views}
            rowKey={(view) => view.changeRequest.id}
            selectedKey={selectedId}
            onRowClick={(view) => setSelectedId(view.changeRequest.id)}
            emptyText="没有待审批的变更"
          />
        )}
      </section>

      {selected && changeRequest && item ? (
        <section className="c-card" data-testid={TESTIDS.approvalItem(changeRequest.id)}>
          <div className="c-page-head">
            <div>
              <h3 style={{ margin: 0 }}>
                {item.title} · <span className="c-mono">{changeRequest.id}</span>
              </h3>
              <div className="c-row" style={{ marginTop: 'var(--space-2)' }}>
                <span className="c-muted">发起人</span>
                <ActorBadge actor={changeRequest.requester} />
                <span className="c-muted">提交于 {formatDateTime(changeRequest.submittedAt)}</span>
                <LevelBadge level={changeRequest.level} />
                <StatusBadge state={changeRequest.state} />
              </div>
            </div>
          </div>

          {changeRequest.requester.kind === 'agent' ? (
            <div className="c-alert is-warning" style={{ marginTop: 'var(--space-3)' }}>
              agent 发起的变更：必须由人类审批人核对 diff 后终审（agent 无终审权）。
            </div>
          ) : null}

          <div style={{ marginTop: 'var(--space-4)' }}>
            <DiffViewer
              title="审批预览（before / after）"
              fields={item.fields}
              before={selected.before}
              after={changeRequest.values}
              impacts={approvalImpacts}
              acknowledged={acknowledged}
              onAcknowledgedChange={setAcknowledged}
              submitting={busy}
              submitLabel="通过并发布（需二次确认）"
              onSubmit={() => setConfirmOpen(true)}
              errorText={errorText}
            />
          </div>

          <div className="c-form" style={{ marginTop: 'var(--space-4)' }}>
            <label className="c-field">
              <span className="c-field-label">approval_ref（写入授权与审计）</span>
              <input
                className="c-input"
                value={approvalRef}
                onChange={(event) => setApprovalRef(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="c-field">
              <span className="c-field-label">驳回原因（驳回必填，进入审计）</span>
              <textarea
                className="c-textarea"
                rows={2}
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                disabled={busy}
              />
            </label>
            <div className="c-diff-actions">
              <button
                type="button"
                className="c-btn is-danger"
                disabled={busy || rejectReason.trim().length === 0}
                onClick={() => void handleReject()}
                data-testid={TESTIDS.approvalReject}
              >
                驳回
              </button>
            </div>
          </div>
        </section>
      ) : (
        <EmptyState title="选择一条待审批变更查看 diff" />
      )}

      <DoubleConfirm
        open={confirmOpen && Boolean(selected && changeRequest && item)}
        title={`通过并发布「${item?.title ?? ''}」`}
        description={dangerDescription('publish', item?.title ?? '')}
        confirmWord={dangerConfirmWord('publish')}
        impacts={approvalImpacts}
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void handleApproveAndPublish()}
      />
    </>
  );
}
