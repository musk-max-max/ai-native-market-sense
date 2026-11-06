import type { ReactNode } from 'react';
import type { Actor } from '../domain/types';
import type { ConsoleRoute } from '../lib/router';
import { ActorBadge } from './ActorBadge';
import { TESTIDS } from '../lib/testids';

export interface NavItem {
  route: ConsoleRoute;
  label: string;
  group: string;
  /** 待审批数量等提示。 */
  badge?: number;
}

export interface AppShellProps {
  active: ConsoleRoute;
  nav: readonly NavItem[];
  title: string;
  subtitle?: string;
  /** 当前操作者（内部员工），用于显示 human actor；agent 操作在列表行内展示。 */
  actor: Actor;
  onNavigate: (route: ConsoleRoute) => void;
  children: ReactNode;
}

/** 四中台共用 layout shell（侧边导航 + 顶栏 + 内容区）。 */
export function AppShell({
  active,
  nav,
  title,
  subtitle,
  actor,
  onNavigate,
  children,
}: AppShellProps) {
  const groups: string[] = [];
  for (const item of nav) {
    if (!groups.includes(item.group)) groups.push(item.group);
  }

  return (
    <div className="c-shell" data-testid={TESTIDS.appShell}>
      <aside className="c-sidebar">
        <div className="c-brand">
          <strong>Market Sense · 中后台</strong>
          <span>运营 · 合规 · 管理 · CRM</span>
        </div>
        <nav className="c-nav" aria-label="主导航">
          {groups.map((group) => (
            <div className="c-nav-group" key={group}>
              <span className="c-nav-group-title">{group}</span>
              {nav
                .filter((item) => item.group === group)
                .map((item) => (
                  <button
                    key={item.route}
                    type="button"
                    className="c-nav-item"
                    aria-current={active === item.route ? 'page' : undefined}
                    onClick={() => onNavigate(item.route)}
                    data-testid={TESTIDS.navItem(item.route)}
                  >
                    {item.label}
                    {item.badge && item.badge > 0 ? <span className="c-nav-badge">{item.badge}</span> : null}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="c-sidebar-foot">
          数据源 tushare · AI 内容仅供参考
          <br />
          所有配置变更：草稿 → 校验 → 审批 → 发布
        </div>
      </aside>

      <div className="c-main">
        <header className="c-topbar">
          <div>
            <h1>{title}</h1>
            {subtitle ? <div className="c-topbar-sub">{subtitle}</div> : null}
          </div>
          <div className="c-topbar-right">
            <ActorBadge actor={actor} />
          </div>
        </header>
        <main className="c-content">{children}</main>
      </div>
    </div>
  );
}
