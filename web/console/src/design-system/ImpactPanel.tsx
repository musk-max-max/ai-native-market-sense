import type { ImpactItem } from '../domain/types';
import { summarizeImpact } from '../domain/impact';
import { TESTIDS } from '../lib/testids';

const KIND_LABEL: Readonly<Record<ImpactItem['kind'], string>> = {
  users: '用户',
  page: '页面',
  downstream: '下游',
  data: '数据',
};

/** 影响面提示面板：配置变更提交/发布前必须展示。 */
export function ImpactPanel({
  impacts,
  title = '影响面',
}: {
  impacts: readonly ImpactItem[];
  title?: string;
}) {
  const summary = summarizeImpact(impacts);
  return (
    <section className="c-impact" data-testid={TESTIDS.impactPanel} aria-label={title}>
      <div className="c-row">
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className="c-muted">
          高 {summary.high} · 中 {summary.medium} · 低 {summary.low}
        </span>
      </div>
      {impacts.length === 0 ? (
        <div className="c-muted">本次变更没有声明影响面（改动字段均未绑定页面/下游）。</div>
      ) : (
        <ul className="c-impact-list">
          {impacts.map((impact) => (
            <li key={`${impact.kind}-${impact.label}`} className={`c-impact-item is-${impact.severity}`}>
              <div className="c-impact-label">
                {impact.label} <span className="c-impact-kind">{KIND_LABEL[impact.kind]} · {impact.severity}</span>
              </div>
              <div className="c-muted">{impact.detail}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
