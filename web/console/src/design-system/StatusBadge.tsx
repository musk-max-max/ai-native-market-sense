import type { ConfigLevel, ConfigState } from '../domain/types';
import { CONFIG_STATE_LABEL } from '../domain/state-machine';
import { TESTIDS } from '../lib/testids';

/** 状态机徽标：草稿 → 已校验 → 待审批 → 已批准 → 已发布（+ 驳回/回滚）。 */
export function StatusBadge({ state }: { state: ConfigState }) {
  return (
    <span className={`c-badge is-${state}`} data-testid={TESTIDS.statusBadge}>
      {CONFIG_STATE_LABEL[state]}
    </span>
  );
}

const LEVEL_LABEL: Readonly<Record<ConfigLevel, string>> = {
  C0: 'C0 · 展示位',
  C1: 'C1 · 低风险（可规则自动放行）',
  C2: 'C2 · 中风险（人类审批）',
  C3: 'C3 · 高风险（人类审批）',
  C4: 'C4 · 最高风险（人类审批）',
};

export function LevelBadge({ level }: { level: ConfigLevel }) {
  return (
    <span className={`c-badge is-${level.toLowerCase()}`} title={LEVEL_LABEL[level]}>
      {level}
    </span>
  );
}
