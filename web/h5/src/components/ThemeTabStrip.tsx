/**
 * 主题 Tab 条（需求 §3.2/§3.3）：三主题 + 二级 Tab「全部指标」。
 * 全部指标 → /stocks/:id/metrics?view=flat（App 只对裸 /metrics 路径做默认首屏重定向，带 view=flat 不回环）。
 */
import { Link, THEME_KEYS, type ThemeKey } from '../lib/router';
import { copy } from '../lib/copy';

const TAB_LABEL: Readonly<Record<ThemeKey, string>> = {
  'fin-health': copy.theme.tab.finHealth,
  'valuation-price': copy.theme.tab.valuationPrice,
  'money-sentiment': copy.theme.tab.moneySentiment,
};

interface ThemeTabStripProps {
  instrumentId: string;
  active: ThemeKey | 'all';
}

export function ThemeTabStrip({ instrumentId, active }: ThemeTabStripProps) {
  const base = '/stocks/' + encodeURIComponent(instrumentId) + '/';
  const itemClass = (isActive: boolean): string =>
    isActive ? 'theme-tabs__item theme-tabs__item--active' : 'theme-tabs__item';
  return (
    <nav className="theme-tabs" data-testid="theme-tabs" aria-label={copy.theme.entryTitle}>
      {THEME_KEYS.map((key) => (
        <Link
          key={key}
          href={base + 'themes/' + key}
          className={itemClass(key === active)}
          data-testid={'theme-tab-' + key}
          aria-current={key === active ? 'page' : undefined}
        >
          {TAB_LABEL[key]}
        </Link>
      ))}
      <Link
        href={base + 'metrics?view=flat'}
        className={itemClass(active === 'all')}
        data-testid="theme-tab-all"
        aria-current={active === 'all' ? 'page' : undefined}
      >
        {copy.theme.tab.allMetrics}
      </Link>
    </nav>
  );
}
