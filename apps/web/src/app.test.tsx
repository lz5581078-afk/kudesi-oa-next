import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker, CurrentUserDto, EffectivePermissions } from '@kudesi/shared';

let currentUser: CurrentUserDto | null = null;
let platformAdmin: { id: number; name: string; account: string } | null = null;

vi.mock('./auth/AuthContext', () => ({
  useAuth: () => ({
    user: currentUser,
    platformAdmin,
    loading: false,
    can: currentUser ? createChecker(currentUser.permissions) : () => false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('./layout/NotificationBell', () => ({ NotificationBell: () => null }));
import { api } from './api/client';
import { App } from './App';

vi.mock('./api/client', async (orig) => ({ ...(await orig<typeof import('./api/client')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);

function userWith(permissions: EffectivePermissions, overrides: Partial<CurrentUserDto> = {}): CurrentUserDto {
  return {
    id: 1,
    name: '测试员',
    account: 'tester',
    companyId: 1,
    companyName: '示例公司',
    positionName: '测试岗位',
    mustChangePassword: false,
    permissions,
    ...overrides,
  };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  currentUser = null;
  platformAdmin = null;
  apiMock.mockReset();
  apiMock.mockImplementation(async () => ({ rows: [], total: 0, counts: { pending: 0, overdue: 0, returned: 0, cc: 0 } }) as never);
});
afterEach(cleanup);

describe('登录与菜单', () => {
  it('未登录显示登录页', () => {
    renderAt('/');
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('登录页不要公司代码，只填账号和密码；可以打开“申请开通公司”', () => {
    renderAt('/');
    expect(screen.queryByText('公司代码')).toBeNull();
    expect(screen.getByText('登录账号')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '申请开通公司' }));
    expect(screen.getByRole('dialog', { name: '申请开通公司' })).toBeTruthy();
    expect(screen.getByText('联系人手机号将作为企业管理员账号')).toBeTruthy();
  });

  it('平台管理员登录后进入平台后台，不出现公司菜单；能看到待审核申请并通过', async () => {
    platformAdmin = { id: 1, name: '平台甲', account: 'root' };
    const row = { id: 7, companyName: '新公司', contactName: '王', contactPhone: '13900000001', contactTitle: null, remark: '想用', status: 'pending', rejectReason: null, reviewedAt: null, reviewedByName: null, approvedCompanyId: null, approvedCompanyName: null, createdAt: '2026-10-26T01:00:00.000Z' };
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/platform/company-applications' && !init?.method) return [row] as never;
      if (path === '/platform/company-applications/7/approve') return { companyId: 9, companyName: '新公司', adminAccount: '13900000001' } as never;
      return [] as never;
    });
    renderAt('/');
    expect(screen.queryByRole('navigation', { name: '一级导航' })).toBeNull();
    expect(screen.getByRole('navigation', { name: '平台导航' })).toBeTruthy();
    expect(await screen.findByText('新公司')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '通过并开通' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: '确认开通' })).getByRole('button', { name: '确认开通' }));
    expect(await screen.findByText(/已开通：新公司，企业管理员账号：13900000001/)).toBeTruthy();
  });

  it('只看到自己有权限的一级菜单；没有商品权限就没有“商品”菜单', () => {
    currentUser = userWith({ isCompanyAdmin: false, allow: ['workbench.todos.view'], deny: [] });
    renderAt('/');
    const top = screen.getByRole('navigation', { name: '一级导航' });
    expect(within(top).getByText('工作台')).toBeTruthy();
    expect(within(top).queryByText('商品')).toBeNull();
    // 首页自动进入第一个可见页面
    expect(screen.getByRole('heading', { name: '我的待办' })).toBeTruthy();
  });

  it('管理员能看到已开放的全部菜单；未开放的页面不在菜单里', () => {
    currentUser = userWith({ isCompanyAdmin: true, allow: [], deny: [] });
    renderAt('/');
    const top = screen.getByRole('navigation', { name: '一级导航' });
    expect(within(top).getByText('工作台')).toBeTruthy();
    expect(within(top).getByText('资料')).toBeTruthy();
    expect(within(top).getByText('财务')).toBeTruthy();
    expect(within(top).getByText('流程')).toBeTruthy();
    // 没有“商品”这样自己发明的一级菜单
    expect(within(top).queryByText('商品')).toBeNull();
    // 二级菜单点开才出现；只列已开放页面
    fireEvent.click(within(top).getByText('财务'));
    const sub = screen.getByRole('navigation', { name: '二级导航' });
    expect(within(sub).getByText('制单中心')).toBeTruthy();
    expect(within(sub).getByText('成本表')).toBeTruthy();
    expect(within(sub).queryByText('岗位看板')).toBeNull();
  });

  it('点一级菜单弹出分组菜单；搜索能跨一级菜单找页面；点链接后收起并进入页面', () => {
    currentUser = userWith({ isCompanyAdmin: true, allow: [], deny: [] });
    renderAt('/');
    const top = screen.getByRole('navigation', { name: '一级导航' });
    expect(screen.queryByRole('navigation', { name: '二级导航' })).toBeNull();
    fireEvent.click(within(top).getByText('资料'));
    const panel = screen.getByRole('dialog', { name: '资料菜单' });
    expect(within(panel).getByText('组织与人员')).toBeTruthy();
    // 在面板里搜索别的一级菜单下的页面
    fireEvent.change(within(panel).getByLabelText('搜索菜单'), { target: { value: '定价调试' } });
    const hit = within(screen.getByRole('navigation', { name: '二级导航' })).getByRole('link', { name: /定价调试表/ });
    fireEvent.click(hit);
    expect(screen.queryByRole('dialog', { name: /菜单/ })).toBeNull();
    expect(screen.getByRole('heading', { name: '定价调试表' })).toBeTruthy();
    // 顶部栏显示当前位置
    expect(within(screen.getByLabelText('当前位置')).getByText('财务')).toBeTruthy();
  });

  it('当前页面在二级菜单里高亮；Esc 收起菜单；手机底栏有常用一级菜单和“更多”', () => {
    currentUser = userWith({ isCompanyAdmin: true, allow: [], deny: [] });
    renderAt('/finance/cost-table');
    fireEvent.click(within(screen.getByRole('navigation', { name: '一级导航' })).getByText('财务'));
    const current = within(screen.getByRole('navigation', { name: '二级导航' })).getByRole('link', { name: '成本表' });
    expect(current.getAttribute('aria-current')).toBe('page');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /菜单/ })).toBeNull();
    const tabbar = screen.getByRole('navigation', { name: '手机底部导航' });
    for (const label of ['工作台', '流程', '财务', '资料', '更多']) expect(within(tabbar).getByText(label)).toBeTruthy();
    fireEvent.click(within(tabbar).getByText('更多'));
    expect(screen.getByRole('dialog', { name: '售后菜单' })).toBeTruthy();
  });

  it('账号菜单：能去修改密码、能退出', () => {
    currentUser = userWith({ isCompanyAdmin: true, allow: [], deny: [] });
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /^账号/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '修改密码' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: '退出登录' })).toBeTruthy();
  });

  it('通过地址直接访问没有权限的页面，显示无权限而不是页面内容', () => {
    currentUser = userWith({ isCompanyAdmin: false, allow: ['workbench.todos.view'], deny: [] });
    renderAt('/finance/cost-table');
    expect(screen.getByText('没有访问权限')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '成本表' })).toBeNull();
  });

  it('初始密码用户看到修改密码提示', () => {
    currentUser = userWith(
      { isCompanyAdmin: true, allow: [], deny: [] },
      { mustChangePassword: true },
    );
    renderAt('/');
    expect(screen.getByRole('alert').textContent).toContain('修改密码');
  });
});

const costRow = {
  bundleId: 1, code: 'ZH-TB-SGPGHFSPGG-2D5KG*2', name: '组合-红富士苹果×2', status: 'verified', categoryId: 3, categoryName: '苹果类',
  preShipCostCents: 1000, weightG: 5000, freightCents: 200, freightMethod: '手工填写', marginPercent: 25, marginSource: '本分类', minPriceCents: 1600, issues: [],
  marginOverride: false, inheritedMargin: { percent: 25, source: '本分类' }, carrierName: '', costIncludingFreightCents: 1200, revision: 'r1',
  lines: [{ role: 'main', code: 'SGPGHFSPGG-2D5KG', name: '红富士苹果', qty: 2, unitCostCents: 500, subtotalCents: 1000, unitWeightG: 2500, weightG: 5000 }],
};
const costTable = (rows: unknown[]) => ({ total: rows.length, page: 1, pageSize: 20, rows, categories: [], defaultMargin: { percent: null, revision: 'none' }, allTotal: rows.length, canEdit: false });

describe('财务 · 成本表与定价调试', () => {
  beforeEach(() => apiMock.mockReset());

  it('成本表显示发货前成本、运费、利润率来源和最低售价，点开看构成', async () => {
    currentUser = userWith({ isCompanyAdmin: false, allow: ['finance.cost-table.view', 'product.cost.view'], deny: [] });
    apiMock.mockResolvedValue(costTable([costRow]));
    renderAt('/finance/cost-table');
    expect(screen.getByRole('heading', { name: '成本表' })).toBeTruthy();
    const row = (await screen.findByText('ZH-TB-SGPGHFSPGG-2D5KG*2')).closest('tr')!;
    expect(within(row).getByText('¥16.00')).toBeTruthy();
    expect(within(row).getByText('继承：本分类')).toBeTruthy();
    expect(within(row).getByText('本组合手工填写')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: '查看组合-红富士苹果×2成本组成' }));
    expect(await screen.findByRole('dialog', { name: '成本组成明细' })).toBeTruthy();
    expect(screen.getByText('红富士苹果')).toBeTruthy();
  });

  it('缺运费时最低售价显示“—”，并提示还缺什么，不用 0 兜底', async () => {
    currentUser = userWith({ isCompanyAdmin: true, allow: [], deny: [] });
    apiMock.mockResolvedValue(costTable([{ ...costRow, freightCents: null, freightMethod: null, costIncludingFreightCents: null, minPriceCents: null, issues: ['运费无法预估（重量段报价不足 3 个省）'] }]));
    renderAt('/finance/cost-table');
    const row = (await screen.findByText('ZH-TB-SGPGHFSPGG-2D5KG*2')).closest('tr')!;
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(within(row).getByText('1 项待补')).toBeTruthy();
  });

  it('没有成本权限时（接口 403）显示接口给的原因，不显示任何金额', async () => {
    currentUser = userWith({ isCompanyAdmin: false, allow: ['finance.cost-table.view'], deny: [] });
    const { ApiError } = await import('./api/client');
    apiMock.mockImplementation(async (path: string) => { if (String(path).startsWith('/finance/cost-table')) throw new ApiError(403, '没有权限'); return []; });
    renderAt('/finance/cost-table');
    expect((await screen.findByRole('alert')).textContent).toContain('没有权限');
    expect(screen.queryByText(/¥/)).toBeNull();
  });

  it('定价调试表：从成本表挑组合，列表显示公司低价（只试算，不保存）', async () => {
    currentUser = userWith({ isCompanyAdmin: true, allow: [], deny: [] });
    apiMock.mockResolvedValue({ rows: [{ id: 1, skuCode: 'ZH-TB-1', skuName: '红富士苹果×2', categoryId: 3, categoryName: '苹果类', ready: true, weightG: 5000, minPriceCents: 1600 }], total: 1, page: 1, pageSize: 30, canViewInternals: true });
    renderAt('/finance/pricing-debug');
    expect(screen.getByRole('heading', { name: '定价调试表' })).toBeTruthy();
    expect(await screen.findByText('红富士苹果×2')).toBeTruthy();
    expect(screen.getByText('公司低价 ¥16.00')).toBeTruthy();
    expect(screen.getByText('尚未选择商品')).toBeTruthy();
  });
});

describe('财务 · 制单中心', () => {
  beforeEach(() => apiMock.mockReset());
  const list = { total: 1, page: 1, pageSize: 20, rows: [{ id: 9, docNo: 'XS20260310001', docType: 'sale', typeLabel: '普通销售单', status: 'posted', docDate: '2026-03-10', amountCents: 4800, memo: null, reversesId: null, partyName: '老客户', createdByName: '老板' }] };

  it('制单中心打开就是开单页；没有制单权限的人只能看最近单据', async () => {
    apiMock.mockResolvedValue(list);
    currentUser = userWith({ isCompanyAdmin: false, allow: ['finance.doc-sale.view'], deny: [] });
    const { unmount } = renderAt('/finance/doc-sale');
    expect(await screen.findByText('XS20260310001')).toBeTruthy();
    expect(screen.getByText('¥48.00')).toBeTruthy();
    expect(screen.queryByRole('form', { name: '普通销售单开单' })).toBeNull();
    unmount();
    currentUser = userWith({ isCompanyAdmin: false, allow: ['finance.doc-sale.view', 'finance.docs.create'], deny: [] });
    renderAt('/finance/doc-sale');
    expect(await screen.findByRole('form', { name: '普通销售单开单' })).toBeTruthy();
  });

  it('开单页：销售单有客户来源、仓库、经办人、明细和结算方式；转款单有转出转入账户', async () => {
    apiMock.mockImplementation(async (path: string) => (String(path).startsWith('/finance/docs') ? list : { items: [], total: 0, page: 1, pageSize: 15 }));
    currentUser = userWith({ isCompanyAdmin: true, allow: [], deny: [] });
    const first = renderAt('/finance/doc-sale');
    const slip = await screen.findByRole('form', { name: '普通销售单开单' });
    expect(within(slip).getByLabelText('客户')).toBeTruthy();
    expect(within(slip).getByLabelText('仓库')).toBeTruthy();
    expect(within(slip).getByLabelText('经办人')).toBeTruthy();
    expect(within(slip).getByLabelText('单据编号')).toBeTruthy();
    fireEvent.change(within(slip).getByLabelText('第1行数量'), { target: { value: '3' } });
    fireEvent.change(within(slip).getByLabelText('第1行单价'), { target: { value: '12.5' } });
    expect(within(slip).getAllByText('¥37.50').length).toBeGreaterThan(0);
    // 结算方式：收了全款 → 收到金额等于合计，欠款为 0
    fireEvent.click(within(slip).getByRole('button', { name: '收了全款' }));
    expect((within(slip).getByLabelText('收到金额') as HTMLInputElement).value).toBe('37.50');
    fireEvent.click(within(slip).getByRole('button', { name: '欠款' }));
    expect((within(slip).getByLabelText('收到金额') as HTMLInputElement).value).toBe('');
    first.unmount();
    renderAt('/finance/doc-transfer');
    const t = await screen.findByRole('form', { name: '转款单开单' });
    expect(within(t).getByLabelText('添加转出账户')).toBeTruthy();
    expect(within(t).getByLabelText('添加转入账户')).toBeTruthy();
    expect(within(t).queryByLabelText('仓库')).toBeNull();
  });
});

describe('我的待办', () => {
  const todos = {
    total: 2, counts: { pending: 2, overdue: 1, returned: 1, cc: 0 },
    rows: [
      { id: 1, runId: 11, title: 't', stepName: '审批', enteredVia: 'return', templateLabel: '借用营业执照/印章', runTitle: '借用甲公司执照', requesterName: '小张', dueAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', finishedAt: null, overdue: true },
      { id: 2, runId: 12, title: 't', stepName: '审批', enteredVia: 'normal', templateLabel: '费用申请', runTitle: '房租 ¥88.00', requesterName: '小李', dueAt: null, createdAt: '2026-01-01T00:00:00Z', finishedAt: null, overdue: false },
    ],
  };
  beforeEach(() => { apiMock.mockReset(); apiMock.mockImplementation(async () => todos as never); });

  it('列出待办，标签显示数量，被退回和逾期用文字标出', async () => {
    currentUser = userWith({ isCompanyAdmin: true, allow: [], deny: [] });
    renderAt('/workbench/todos');
    expect(await screen.findByText(/借用甲公司执照/)).toBeTruthy();
    expect(screen.getByText('被退回')).toBeTruthy();
    expect(screen.getByText(/已超时/)).toBeTruthy();
    expect(screen.getByText('不限时')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /待办理 \(2\)/ })).toBeTruthy();
  });
});
