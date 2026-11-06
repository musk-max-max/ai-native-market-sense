import type { ConfigFieldDef, ConfigLevel, ImpactItem } from './types';
import { levelRank } from './registry';
import type { FieldDiff } from './diff';

/**
 * 影响面提示（硬约束：配置变更必须先展示 before/after diff + 影响范围再允许提交）。
 * 影响面由字段的 affects 声明 + 配置等级推导；发布前必须展示给操作者并确认。
 */

function severityForLevel(level: ConfigLevel): ImpactItem['severity'] {
  const rank = levelRank(level);
  if (rank >= 3) return 'high';
  if (rank === 2) return 'medium';
  return 'low';
}

export function computeImpact(
  fields: readonly ConfigFieldDef[],
  diffs: readonly FieldDiff[],
  itemLevel: ConfigLevel,
): ImpactItem[] {
  const changedKeys = new Set(diffs.filter((row) => row.kind !== 'unchanged').map((row) => row.key));
  if (changedKeys.size === 0) return [];

  const impacts = new Map<string, ImpactItem>();
  const severity = severityForLevel(itemLevel);

  for (const field of fields) {
    if (!changedKeys.has(field.key)) continue;
    for (const page of field.affects ?? []) {
      const existing = impacts.get(`page:${page}`);
      if (existing) {
        impacts.set(`page:${page}`, {
          ...existing,
          detail: `${existing.detail}；${field.label}`,
        });
      } else {
        impacts.set(`page:${page}`, {
          kind: 'page',
          label: page,
          detail: `字段「${field.label}」变更会直接影响该页面。`,
          severity,
        });
      }
    }
  }

  if (levelRank(itemLevel) >= 3) {
    impacts.set('users:all', {
      kind: 'users',
      label: '全部 C 端用户',
      detail: '高等级运营配置，发布后对所有在线用户生效。',
      severity: 'high',
    });
    impacts.set('downstream:cache', {
      kind: 'downstream',
      label: '只读缓存 / 聚合接口',
      detail: '发布后需等待缓存失效（≤5 分钟），期间新旧值可能并存。',
      severity: 'medium',
    });
  }

  impacts.set('data:release', {
    kind: 'data',
    label: 'release 链',
    detail: '发布生成不可变 release；如需恢复，可回滚到上一版本（追加新 release）。',
    severity: 'low',
  });

  return [...impacts.values()];
}

export interface ImpactSummary {
  high: number;
  medium: number;
  low: number;
  total: number;
}

export function summarizeImpact(impacts: readonly ImpactItem[]): ImpactSummary {
  const summary: ImpactSummary = { high: 0, medium: 0, low: 0, total: impacts.length };
  for (const impact of impacts) {
    summary[impact.severity] += 1;
  }
  return summary;
}

/** 危险操作（全量发布 / 回滚）需要二次确认时展示的影响面文案。 */
export function dangerConfirmWord(action: 'publish' | 'rollback'): string {
  return action === 'publish' ? '发布' : '回滚';
}

export function dangerDescription(action: 'publish' | 'rollback', itemTitle: string): string {
  if (action === 'publish') {
    return `即将把「${itemTitle}」的新版本发布到 C 端，影响全部在线用户。`;
  }
  return `即将回滚「${itemTitle}」到历史版本，会追加一条新 release（历史不删除）。`;
}
