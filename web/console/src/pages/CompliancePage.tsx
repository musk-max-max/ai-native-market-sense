import type { AuditEvent } from '../domain/types';
import { LOCKED_CONFIG_AREAS } from '../domain/registry';
import { ActorBadge, DataTable, type Column } from '../design-system';
import { formatDateTime } from '../lib/format';
import type { ConsoleServices } from '../lib/services';
import { useAsync } from '../lib/use-async';

export interface CompliancePageProps {
  services: ConsoleServices;
}

const ACTION_LABEL: Record<AuditEvent['action'], string> = {
  'draft.saved': '保存草稿',
  'config.validated': '校验配置',
  'approval.submitted': '提交审批',
  'approval.approved': '审批通过',
  'approval.rejected': '驳回变更',
  'config.published': '发布配置',
  'config.rolled_back': '回滚配置',
};

/**
 * 合规中台（只读）。
 * 这里展示的 6 类不可配项只用于"说明为什么没有入口"，
 * 不渲染任何编辑按钮/表单/跳转——这是硬约束（H6）。
 */
export function CompliancePage({ services }: CompliancePageProps) {
  const auditState = useAsync(() => services.listAudit(), [services]);
  const events = [...(auditState.data ?? [])].reverse();

  const lockedColumns: Column<(typeof LOCKED_CONFIG_AREAS)[number]>[] = [
    { key: 'id', title: '项', render: (area) => <span className="c-mono">{area.id}</span> },
    { key: 'title', title: '名称', render: (area) => area.title },
    { key: 'lockedBy', title: '锁定依据', render: (area) => <span className="c-muted">{area.lockedBy}</span> },
    { key: 'reason', title: '说明', render: (area) => area.reason },
    {
      key: 'action',
      title: '操作',
      render: () => <span className="c-muted">不可配（无入口）</span>,
    },
  ];

  const auditColumns: Column<AuditEvent>[] = [
    {
      key: 'at',
      title: '时间',
      render: (event) => <span className="c-muted">{formatDateTime(event.at)}</span>,
    },
    { key: 'action', title: '动作', render: (event) => ACTION_LABEL[event.action] },
    { key: 'item', title: '对象', render: (event) => <span className="c-mono">{event.itemId}</span> },
    { key: 'actor', title: '来源', render: (event) => <ActorBadge actor={event.actor} /> },
    { key: 'detail', title: '详情', render: (event) => event.detail },
  ];

  const agentEvents = events.filter((event) => event.actor.kind === 'agent').length;

  return (
    <>
      <section className="c-page-head">
        <div>
          <h2>合规中台</h2>
          <p className="c-page-desc">
            只读视图：锁定项、AI 内容标识、审计来源。合规相关文案不允许在中后台配置或弱化。
          </p>
        </div>
      </section>

      <div className="c-cards">
        <div className="c-card c-stat">
          <span className="c-stat-label">锁定项</span>
          <strong className="c-stat-value">{LOCKED_CONFIG_AREAS.length}</strong>
          <span className="c-muted">界面零入口</span>
        </div>
        <div className="c-card c-stat">
          <span className="c-stat-label">审计事件</span>
          <strong className="c-stat-value">{events.length}</strong>
          <span className="c-muted">草稿→审批→发布全链路</span>
        </div>
        <div className="c-card c-stat">
          <span className="c-stat-label">agent 来源事件</span>
          <strong className="c-stat-value">{agentEvents}</strong>
          <span className="c-muted">含 modelVersion / runId</span>
        </div>
      </div>

      <section className="c-card">
        <h3>不可配项（只读登记）</h3>
        <p className="c-muted" style={{ marginTop: 0 }}>
          以下 6 类项在任何页面都不渲染编辑入口；如需变更，走合规/法务线下流程，不属于中后台配置链路。
        </p>
        <DataTable
          columns={lockedColumns}
          rows={LOCKED_CONFIG_AREAS}
          rowKey={(area) => area.id}
          emptyText="无锁定项"
        />
      </section>

      <section className="c-card">
        <h3>AI 内容标识要求</h3>
        <div className="c-alert is-warning">
          AI 生成内容必须同时带「ai.generated」标记与免责声明「AI 生成·仅供参考」。此两项目前由
          contracts/ai 与 A5 合规层强制注入，中后台不提供任何开关。
        </div>
        <div className="c-kv">
          <span>AI 标识</span>
          <span className="c-mono">locked · 不可配</span>
          <span>免责声明</span>
          <span className="c-mono">locked · 不可配</span>
          <span>as_of 口径</span>
          <span className="c-mono">由数据链路生成 · 只读</span>
        </div>
      </section>

      <section className="c-card">
        <h3>审计来源（人类 / agent 可区分）</h3>
        {auditState.loading ? (
          <div className="c-muted">加载中…</div>
        ) : (
          <DataTable
            columns={auditColumns}
            rows={events}
            rowKey={(event) => event.id}
            emptyText="暂无审计事件"
          />
        )}
      </section>
    </>
  );
}
