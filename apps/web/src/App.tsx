import { ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { NAV_SECTIONS, RESOURCE_COMPANIONS, PAGE_TABS, RESOURCE_VIEWS, visibleSections, type DocType } from '@kudesi/shared';
import { useAuth } from './auth/AuthContext';
import { Shell } from './layout/Shell';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { LoginPage } from './pages/LoginPage';
import { AuditPage } from './pages/system/AuditPage';
import { BankFundPage } from './pages/system/BankFundPage';
import { FeeSettingsPage } from './pages/system/FeeSettingsPage';
import { NoAccessPage, NotFoundPage } from './pages/StatusPages';
import { CashBankPage } from './pages/finance/CashBankPage';
import { CostTablePage } from './pages/finance/CostTablePage';
import { StoreWithdrawalPage } from './pages/finance/StoreWithdrawalPage';
import { CompanionPage } from './resources/CompanionPage';
import { MaintenancePage } from './pages/finance/MaintenancePage';
import { DocumentsPage } from './pages/finance/DocumentsPage';
import { VoucherPage } from './pages/finance/VoucherPage';
import { FinanceOverviewPage } from './pages/finance/FinanceOverviewPage';
import { SettlementDetailPage, UnsettledReceiptsPage } from './pages/finance/SettlementPages';
import { ApiKeysPage, CostHistoryPage, JstSyncPage, MasterResetPage, PackagingMatchPage, ZoneSuggestionPage } from './pages/finance/DataToolPages';
import { TabHost, type HostTab } from './layout/TabHost';
import { ExpressPricesPage } from './pages/finance/express/ExpressPricesPage';
import { FreightEstimatePage } from './pages/finance/express/FreightEstimatePage';
import { ZoneRunsPage } from './pages/finance/express/ZoneRunsPage';
import { LaborCostPage } from './pages/finance/labor/LaborCostPage';
import { MasterImportPage } from './pages/finance/MasterImportPage';
import { BaseCodesPage } from './pages/finance/jst/BaseCodesPage';
import { BundlesPage } from './pages/finance/jst/BundlesPage';
import { JstUploadPage } from './pages/finance/jst/JstUploadPage';
import { InventoryPage } from './pages/finance/InventoryPage';
import { PricingDebugPage } from './pages/finance/PricingDebugPage';
import { ResourceOverviewPage } from './resources/OverviewPage';
import { ResourcePage } from './resources/ResourcePage';
import { IntegrationsPage } from './pages/system/IntegrationsPage';
import { StaffPage } from './pages/org/StaffPage';
import { StructurePage } from './pages/org/StructurePage';
import { PositionProfilesPage } from './pages/org/PositionProfilesPage';
import { ApplyPage } from './pages/flow/ApplyPage';
import { TasksPage } from './pages/flow/TasksPage';
import { RunsPage } from './pages/flow/RunsPage';
import { TemplatesPage } from './pages/flow/TemplatesPage';
import { MyTodosPage } from './pages/flow/TodosPage';

/**
 * 页面组件登记：键是导航注册表里的“分区.页面id”。
 * 新做一个页面 = 在这里登记组件 + 把注册表里该页面的 ready 改成 true。
 */
const PAGE_COMPONENTS: Record<string, ComponentType> = {
  'workbench.todos': MyTodosPage,
  'workbench.tasks': TasksPage,
  'workbench.started': () => <RunsPage view="started" />,
  'workbench.cc': () => <RunsPage view="cc" />,
  'flow.apply': ApplyPage,
  'flow.overview': () => <RunsPage view="all" />,
  'flow.templates': TemplatesPage,
  'finance.overview': FinanceOverviewPage,
  'finance.cost-table': CostTablePage,
  'finance.pricing-debug': PricingDebugPage,
  'finance.inventory': InventoryPage,
  'finance.cash-bank': CashBankPage,
  'finance.settlement-detail': SettlementDetailPage,
  'finance.unsettled-receipts': UnsettledReceiptsPage,
  'finance.master-import': MasterImportPage,
  'finance.cost-history': CostHistoryPage,
  'finance.zone-suggestion': ZoneSuggestionPage,
  'finance.packaging-match': PackagingMatchPage,
  'finance.api-keys': ApiKeysPage,
  'finance.jst-sync': JstSyncPage,
  'finance.master-reset': MasterResetPage,
  'resource.overview': ResourceOverviewPage,
  'system.integrations': IntegrationsPage,
  'system.audit': AuditPage,
  'resource.bank-fund': BankFundPage,
  'resource.fee-settings': FeeSettingsPage,
  'resource.company-store-maintenance': MaintenancePage,
  'resource.org-tree': StructurePage,
  'resource.employees': StaffPage,
  'resource.position-profiles': PositionProfilesPage,
};

// 资料页面全部由同一个通用页面按资源类型渲染；组件在模块加载时各建一次，避免每次渲染重新挂载
for (const section of NAV_SECTIONS) {
  if (section.id !== 'resource' && section.id !== 'finance') continue;
  for (const page of section.pages) {
    if (page.id === 'overview' || page.id === 'bank-fund' || page.id === 'fee-settings' || page.id === 'company-store-maintenance' || page.id === 'org-tree' || page.id === 'employees' || page.id === 'position-profiles') continue;
    let Page: ComponentType | null = null;
    const view = section.id === 'resource' ? RESOURCE_VIEWS.find((v) => v.id === page.id) : undefined;
    if (view) Page = () => <ResourcePage type={view.type} lockedTab={view.tab} title={view.label} />;
    else if (section.id === 'resource' && RESOURCE_COMPANIONS[page.id]) Page = () => <CompanionPage type={page.id} />;
    else if (section.id === 'resource' || page.id.startsWith('finance-')) Page = () => <ResourcePage type={page.id} />;
    else if (page.id === 'drafts' || page.id === 'history') Page = () => <DocumentsPage scope={page.id as 'drafts' | 'history'} />;
    else if (page.id === 'doc-withdrawal') Page = StoreWithdrawalPage;
    else if (page.id.startsWith('doc-')) Page = () => <VoucherPage type={page.id.slice(4) as DocType} />;
    if (!Page) continue;
    Page.displayName = `Page(${section.id}.${page.id})`;
    PAGE_COMPONENTS[`${section.id}.${page.id}`] = Page;
  }
}

// 人力成本表、快递价格表有自己的专用页面（版本/分类树/层级），覆盖通用资料页
PAGE_COMPONENTS['finance.finance-labor-costs'] = LaborCostPage;
PAGE_COMPONENTS['finance.finance-express-prices'] = ExpressPricesPage;
PAGE_COMPONENTS['finance.zone-suggestion'] = ZoneRunsPage;

// 聚水潭分类：基础编码和组合编码有自己的页面（核对验证、批量生成等），其余页签仍用通用资料页
PAGE_COMPONENTS['finance.finance-base-codes'] = BaseCodesPage;
PAGE_COMPONENTS['finance.finance-bundles'] = BundlesPage;
PAGE_COMPONENTS['finance.jst-upload'] = JstUploadPage;

// 宿主页：旧程序里的页面内 Tab/面板，合并为标签页（不再单独占菜单）
for (const [hostKey, tabs] of Object.entries(PAGE_TABS)) {
  const [section, hostId] = hostKey.split('/');
  const hostComponent = PAGE_COMPONENTS[`${section}.${hostId}`];
  const hostTabs: HostTab[] = tabs.map((t, i) => {
    let Component: ComponentType | undefined;
    if (i === 0 && hostComponent) Component = hostComponent;
    else if (PAGE_COMPONENTS[`finance.${t.ref}`] && !t.ref.startsWith('finance-')) Component = PAGE_COMPONENTS[`finance.${t.ref}`];
    else if (t.ref === 'jst-sync') Component = JstSyncPage;
    else if (t.ref === 'finance-freight-overrides') Component = FreightEstimatePage;
    else Component = () => <ResourcePage type={t.ref} />;
    return { ...t, Component };
  });
  const Host = () => <TabHost tabs={hostTabs} />;
  Host.displayName = `Host(${hostKey})`;
  PAGE_COMPONENTS[`${section}.${hostId}`] = Host;
}

export function App() {
  const { user, loading, can } = useAuth();

  if (loading) return <div className="center-screen">加载中…</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  const landing = visibleSections(can)[0]?.landingPath;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={landing ? <Navigate to={landing} replace /> : <NoAccessPage />} />
        <Route path="/account/password" element={<ChangePasswordPage />} />
        {NAV_SECTIONS.flatMap((section) =>
          section.pages
            .filter((page) => page.ready && PAGE_COMPONENTS[`${section.id}.${page.id}`])
            .map((page) => {
              const Component = PAGE_COMPONENTS[`${section.id}.${page.id}`];
              return (
                <Route
                  key={page.path}
                  path={page.path}
                  element={can(page.permission) ? <Component /> : <NoAccessPage />}
                />
              );
            }),
        )}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
