import { LOCKED_CONFIG_AREAS } from '../domain/registry';
import type { AuditEvent } from '../domain/types';
import type { ConfigItemSummary } from '../mocks/ports';
import { ActorBadge, DataTable, LevelBadge, StatusBadge, type Column } from '../design-system';
import { formatDateTime, shortId } from '../lib/format';
import type { ConsoleServices } from '../lib/services';
import { useAsync } from '../lib/use-async';

const ACTION_LABEL: Readonly<Record<AuditEvent['action'], string>> = {
  'draft.saved': '保存草稿',
  'config.validated': '校验通过',
  'approval.submitted': '提交审批',
  'approval.approved': '审批通过',
  'approval.rejected': '审批驳回',
  'config.published': '发布',
  'config.rolled_back': '回滚',
};

export interface OverviewPageProps {
  services: ConsoleServices;
  onOpenItem: (itemId: string) => void;
}

/** 运营数据看板：配置态 + 待审批 + 最近审计（只读聚合）。 */
export function OverviewPage({ services, onOpenItem }: OverviewPageProps) {
  const state = useAsync(
    async () => {
      const [items, pending, audit] = await Promise.all([
        services.list(),
        services.listPending(),
        services.listAudit(),
      ]);
      return { items, pending, audit };
    },
    [services],
  );

  if (state.loading) return <div className="c-card">加载中…</div>;
  if (state.error) return <div className="c-card c-alert is-danger">{state.error}</div>;

  const { items = [], pending = [], audit = [] } = state.data ?? {};

  const itemColumns: Column<ConfigItemSummary>[] = [
    {
      key: 'title',
      title: '配置项',
      render: (row) => (
        <div>
          <div>{row.item.title}</div>
          <div className="c-mono c-muted">{row.item.id}</div>
        </div>
      ),
    },
    { key: 'level', title: '等级', render: (row) => <LevelBadge level={row.item.level} /> },
    { key: 'version', title: '已发布', render: (row) => <span className="c-mono">v{row.publishedVersion}</span> },
    {
      key: 'draft',
      title: '草稿状态',
      render: (row) =>
        row.draft ? <StatusBadge state={row.draft.state} /> : <span className="c-muted">—</span>,
    },
    {
      key: 'pending',
      title: '待审批',
      render: (row) =>
        row.pendingApprovals > 0 ? (
          <span className="c-badge is-pending_approval">{row.pendingApprovals}</span>
        ) : (
          <span className="c-muted">0</span>
        ),
    },
    {
      key: 'publishedAt',
      title: '最近发布',
      render: (row) => <span className="c-muted">{formatDateTime(row.publishedAt)}</span>,
    },
  ];

  const auditColumns: Column<AuditEvent>[] = [
    { key: 'at', title: '时间', render: (row) => <span className="c-muted">{formatDateTime(row.at)}</span> },
    { key: 'actor', title: '操作者', render: (row) => <ActorBadge actor={row.actor} /> },
    { key: 'action', title: '动作', render: (row) => ACTION_LABEL[row.action] },
    { key: 'item', title: '配置项', render: (row) => <span className="c-mono">{row.itemId}</span> },
    {
      key: 'detail',
      title: '明细',
      render: (row) => <span className="c-muted">{shortId(row.detail, 60)}</span>,
    },
  ];

  return (
    <>
      <section className="c-page-head">
        <div>
          <h2>配置看板</h2>
          <p className="c-page-desc">
            四中台共用一套配置状态：草稿 → 校验 → 审批 → 发布。agent 与人类操作都在审计里可区分来源。
          </p>
        </div>
      </section>

      <section className="c-cards">
        <div className="c-stat">
          <span className="c-stat-label">可配置项</span>
          <span className="c-stat-value">{items.length}</span>
        </div>
        <div className="c-stat">
          <span className="c-stat-label">待审批</span>
          <span className="c-stat-value">{pending.length}</span>
        </div>
        <div className="c-stat">
          <span className="c-stat-label">不可配项（合规锁定）</span>
          <span className="c-stat-value">{LOCKED_CONFIG_AREAS.length}</span>
        </div>
        <div className="c-stat">
          <span className="c-stat-label">审计事件（本次会话）</span>
          <span className="c-stat-value">{audit.length}</span>
        </div>
      </section>

      <section className="c-card">
        <div className="c-row">
          <h3 style={{ margin: 0 }}>配置项状态</h3>
          <span className="c-muted">点击任意行进入配置编辑器</span>
        </div>
        <div style={{ marginTop: 'var(--space-3)' }}>
          <DataTable
            columns={itemColumns}
            rows={items}
            rowKey={(row) => row.item.id}
            onRowClick={(row) => onOpenItem(row.item.id)}
            emptyText="没有可配置项"
          />
        </div>
      </section>

      <section className="c-card">
        <h3>最近审计</h3>
        <DataTable
          columns={auditColumns}
          rows={[...audit].reverse().slice(0, 8)}
          rowKey={(row) => row.id}
          emptyText="还没有审计事件"
        />
      </section>
    </>
  );
}
