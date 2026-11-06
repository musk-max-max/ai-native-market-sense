import { useEffect, useState } from 'react';
import type { Actor } from './domain/types';
import { AppShell, type NavItem } from './design-system';
import { ROUTES, navigate, useRoute, type ConsoleRoute } from './lib/router';
import type { ConsoleServices } from './lib/services';
import { useAsync } from './lib/use-async';
import { MockBackend } from './mocks';
import { ApprovalQueuePage } from './pages/ApprovalQueuePage';
import { CompliancePage } from './pages/CompliancePage';
import { ConfigEditorPage } from './pages/ConfigEditorPage';
import { CrmPage } from './pages/CrmPage';
import { OverviewPage } from './pages/OverviewPage';
import { configurableItems } from './domain/registry';

/**
 * ⚠️ 当前使用 MockBackend（Config Service / Approval API 契约未建）。
 * 未来由 src/adapters/http-config-service.ts 等实现同一 ConsoleServices 接口替换，
 * 页面与组件不感知 mock/http 差异。见 src/mocks/CONTRACT-MAP.md。
 */
const services: ConsoleServices = new MockBackend({ seedDemoApprovals: true });
/** 演示用内部员工身份；真实身份来自 A4 identity（/v1/internal/*），前端只展示不判定。 */
const consoleActor: Actor = { kind: 'human', id: 'H2' };

const GROUP_LABEL: Readonly<Record<string, string>> = {
  ops: '运营',
  admin: '管理',
  compliance: '合规',
  crm: 'CRM',
};

const PAGE_TITLE: Readonly<Record<ConsoleRoute, { title: string; subtitle: string }>> = {
  overview: { title: '运营配置 + 数据看板', subtitle: '配置态 · 待审批 · 审计来源' },
  config: { title: '配置编辑器', subtitle: '草稿 → 校验 → 审批 → 发布（所有变更须核对 diff）' },
  approvals: { title: '流程审批', subtitle: '单条审批 · 人类终审 · agent 只能发起' },
  compliance: { title: '合规中台', subtitle: '锁定项 · AI 标识 · 审计来源（只读）' },
  crm: { title: 'CRM', subtitle: '跟进规则 + 客户名单（P2 占位）' },
};

export function App() {
  const route = useRoute();
  const [itemId, setItemId] = useState<string | null>(
    configurableItems()[0]?.id ?? null,
  );
  const pendingState = useAsync(() => services.listPending(), [services]);
  const pendingCount = pendingState.data?.length ?? 0;

  useEffect(() => {
    if (route === 'config' && itemId && !configurableItems().some((item) => item.id === itemId)) {
      setItemId(configurableItems()[0]?.id ?? null);
    }
  }, [route, itemId]);

  const nav: NavItem[] = ROUTES.map((definition) => ({
    route: definition.id,
    label: definition.label,
    group: GROUP_LABEL[definition.group] ?? definition.group,
    badge: definition.id === 'approvals' ? pendingCount : undefined,
  }));

  const heading = PAGE_TITLE[route];

  function openItem(nextItemId: string): void {
    setItemId(nextItemId);
    navigate('config');
  }

  const refreshPending = (): void => {
    pendingState.reload();
  };

  return (
    <AppShell
      active={route}
      nav={nav}
      title={heading.title}
      subtitle={heading.subtitle}
      actor={consoleActor}
      onNavigate={(next) => navigate(next)}
    >
      {route === 'overview' ? <OverviewPage services={services} onOpenItem={openItem} /> : null}
      {route === 'config' ? (
        <ConfigEditorPage
          services={services}
          actor={consoleActor}
          itemId={itemId}
          onSelectItem={setItemId}
          onPendingApprovalsChange={refreshPending}
        />
      ) : null}
      {route === 'approvals' ? (
        <ApprovalQueuePage
          services={services}
          actor={consoleActor}
          onPendingApprovalsChange={refreshPending}
        />
      ) : null}
      {route === 'compliance' ? <CompliancePage services={services} /> : null}
      {route === 'crm' ? <CrmPage services={services} onOpenItem={openItem} /> : null}
    </AppShell>
  );
}
