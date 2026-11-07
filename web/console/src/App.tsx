import { useEffect, useState } from 'react';
import type { Actor } from './domain/types';
import { AppShell, type NavItem } from './design-system';
import { ROUTES, navigate, useRoute, type ConsoleRoute } from './lib/router';
import type { ConsoleServices } from './lib/services';
import { useAsync } from './lib/use-async';
import { MockBackend } from './mocks';
import { createHttpConsoleServices } from './adapters';
import { ApprovalQueuePage } from './pages/ApprovalQueuePage';
import { CompliancePage } from './pages/CompliancePage';
import { ConfigEditorPage } from './pages/ConfigEditorPage';
import { CrmPage } from './pages/CrmPage';
import { OverviewPage } from './pages/OverviewPage';
import { configurableItems } from './domain/registry';

/**
 * 运行时服务装配：
 * - 默认 MockBackend（seedDemoApprovals）——本地开发 / 无真契约后端时使用。
 * - 切 HTTP：URL query 带 ?backend=http&baseUrl=/v1&environment=dev（或注入 VITE_CONSOLE_API_URL）。
 *   ConsoleServices 由 createHttpConsoleServices 组装 ConfigServicePort + ApprovalServicePort + AuditPort。
 *   页面与组件不感知 mock/http 差异，见 src/mocks/CONTRACT-MAP.md。
 */
/** Vite build 注入 import.meta.env；测试环境可能缺，兜底空对象。 */
function viteEnv(): Record<string, string | undefined> {
  try {
    return (import.meta.env ?? {}) as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

function bootstrapServices(): ConsoleServices {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const env = viteEnv();
  const backend = (params.get('backend') ?? env.VITE_CONSOLE_BACKEND ?? 'mock').toLowerCase();
  if (backend !== 'http') {
    return new MockBackend({ seedDemoApprovals: true });
  }
  const baseUrl = params.get('baseUrl') ?? env.VITE_CONSOLE_API_URL ?? '/v1';
  const environment = (params.get('environment') ?? env.VITE_CONSOLE_ENV ?? 'dev') as 'dev' | 'staging' | 'prod';
  // authHeaders 默认走同源 cookie/credentials；A4 identity 接入后可改 Bearer token。
  return createHttpConsoleServices({
    baseUrl,
    environment,
    authHeaders: () => ({}),
  });
}

const services: ConsoleServices = bootstrapServices();
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
