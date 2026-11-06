import { findConfigItem } from '../domain/registry';
import { LevelBadge } from '../design-system';
import { EmptyState } from '../design-system';
import type { ConsoleServices } from '../lib/services';
import { useAsync } from '../lib/use-async';

export interface CrmPageProps {
  services: ConsoleServices;
  onOpenItem: (itemId: string) => void;
}

/** CRM 中台：P2 占位。名单/跟进记录待 A16 CRM Service 契约，跟进规则已可配置。 */
export function CrmPage({ services, onOpenItem }: CrmPageProps) {
  const state = useAsync(() => services.list(), [services]);
  const crmItem = findConfigItem('crm.followup');
  const summary = (state.data ?? []).find((row) => row.item.id === 'crm.followup');

  return (
    <>
      <section className="c-page-head">
        <div>
          <h2>CRM</h2>
          <p className="c-page-desc">
            四合一 CRM：客户名单与跟进记录 P2 占位；跟进规则走与运营相同的 草稿→校验→审批→发布 链路。
          </p>
        </div>
      </section>

      <div className="c-cards">
        <div className="c-card c-stat">
          <span className="c-stat-label">跟进规则</span>
          <strong className="c-stat-value">{summary ? `v${summary.publishedVersion}` : '—'}</strong>
          <span className="c-muted">{crmItem ? crmItem.title : '未注册'}</span>
        </div>
        <div className="c-card c-stat">
          <span className="c-stat-label">待接入</span>
          <strong className="c-stat-value">名单</strong>
          <span className="c-muted">等待 A16 CRM Service 契约</span>
        </div>
      </div>

      {crmItem ? (
        <section className="c-card">
          <div className="c-row">
            <h3 style={{ margin: 0 }}>{crmItem.title}</h3>
            <LevelBadge level={crmItem.level} />
            <span className="c-spacer" />
            <button type="button" className="c-btn" onClick={() => onOpenItem(crmItem.id)}>
              打开配置
            </button>
          </div>
          <p className="c-muted">{crmItem.fields.map((field) => field.label).join(' · ')}</p>
        </section>
      ) : null}

      <section className="c-card">
        <EmptyState
          title="客户名单与跟进记录 P2 接入"
          hint="待 A16 CRM Service 提供 /v1/internal/crm 契约后接入；本次不伪造客户数据。"
        />
      </section>
    </>
  );
}
