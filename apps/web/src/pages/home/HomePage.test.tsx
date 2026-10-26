import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker, type CurrentUserDto, type EffectivePermissions, type HomeDto } from '@kudesi/shared';

let currentUser: CurrentUserDto | null = null;
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: currentUser, loading: false, can: currentUser ? createChecker(currentUser.permissions) : () => false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../layout/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('../../api/client', async (orig) => ({ ...(await orig<typeof import('../../api/client')>()), api: vi.fn() }));
import { api, ApiError } from '../../api/client';
import { App } from '../../App';

const apiMock = vi.mocked(api);
const perms = (allow: string[], isCompanyAdmin = false): EffectivePermissions => ({ isCompanyAdmin, allow, deny: [] });
const userWith = (permissions: EffectivePermissions): CurrentUserDto => ({ id: 1, name: '测试员', account: 't', companyId: 1, companyName: '示例公司', positionName: '测试岗位', mustChangePassword: false, permissions });
const renderHome = () => render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);

const base = (over: Partial<HomeDto> = {}): HomeDto => ({
  workspace: { type: 'blank', title: '我的工作台', focus: '待办 · 申请', positionName: null, types: ['blank'] },
  widgets: ['todos', 'started'],
  todos: { pending: 0, overdue: 0, returned: 0, cc: 0, rows: [] },
  started: { running: 0, rows: [] },
  ...over,
});
const mockHome = (dto: HomeDto) => apiMock.mockImplementation(async (path: string) => { if (path === '/home') return dto as never; return [] as never; });

beforeEach(() => { currentUser = null; apiMock.mockReset(); });
afterEach(cleanup);

describe('首页', () => {
  it('老板首页：财务、店铺排行、逾期流程、人员排行、资料预警按服务端返回的卡片展示，金额按分换算', async () => {
    currentUser = userWith(perms([], true));
    mockHome(base({
      workspace: { type: 'boss', title: '老板工作台', focus: '经营总览 · 异常跟进', positionName: null, types: ['boss'] },
      widgets: ['finance', 'stores', 'flowAlerts', 'people', 'resourceAlerts', 'todos', 'started'],
      finance: { month: '2026-10', revenueCents: 450000, expenseCents: 12000, netProfitCents: 300000, bankCents: 8800000, receivableCents: 0, payableCents: 5000, drafts: 2, issued: 1, trend: [{ date: '2026-10-02', revenueCents: 450000, profitCents: 300000 }] },
      stores: { rows: [{ storeId: 1, name: '一号店', platform: 'pdd', salesCents: 450000, profitCents: 300000 }] },
      flowAlerts: { overdue: 1, rows: [{ id: 7, title: '借执照-甲', templateLabel: '借用营业执照', requesterName: '小张', stepName: '审批', handlers: ['王经理'], dueAt: '2026-10-01T00:00:00.000Z', overdue: true }] },
      people: { rows: [{ userId: 3, name: '小李', pending: 4, overdue: 2 }] },
      resourceAlerts: { abnormalTotal: 1, abnormal: [{ type: 'stores', label: '店铺', abnormal: 1 }], alerts: [{ type: 'phones', typeLabel: '手机号', id: 5, title: '138****0000', label: '套餐到期', days: -3 }] },
    }));
    renderHome();
    expect(await screen.findByRole('heading', { name: '老板工作台' })).toBeTruthy();
    const fin = screen.getByRole('region', { name: '本月经营（2026-10）' });
    expect(within(fin).getByText('¥4,500.00')).toBeTruthy();
    expect(within(fin).getByText('净利润')).toBeTruthy();
    expect(within(fin).getByText('¥88,000.00')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '店铺销售排行' })).getByText('pdd / 一号店')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '逾期未办结的流程' })).getByRole('link', { name: '借执照-甲' }).getAttribute('href')).toBe('/flow/overview?run=7');
    expect(within(screen.getByRole('region', { name: '人员逾期排行' })).getByText('小李')).toBeTruthy();
    const alerts = screen.getByRole('region', { name: '资料预警' });
    expect(within(alerts).getByText('店铺异常 1')).toBeTruthy();
    expect(within(alerts).getByText('已过 3 天')).toBeTruthy();
    // 没有的卡片不出现
    expect(screen.queryByRole('region', { name: '库存缺货' })).toBeNull();
    expect(apiMock).toHaveBeenCalledWith('/home');
  });

  it('没有成本权限：服务端把利润置空，页面不显示净利润和店铺利润列', async () => {
    currentUser = userWith(perms(['finance.overview.view']));
    mockHome(base({
      workspace: { type: 'finance', title: '财务工作台', focus: '', positionName: '会计', types: ['finance'] },
      widgets: ['finance', 'stores'],
      finance: { month: '2026-10', revenueCents: 100, expenseCents: 0, netProfitCents: null, bankCents: null, receivableCents: 0, payableCents: 0, drafts: 0, issued: 0, trend: [] },
      stores: { rows: [{ storeId: 1, name: '店', platform: '', salesCents: 100, profitCents: null }] },
    }));
    renderHome();
    await screen.findByRole('region', { name: '本月经营（2026-10）' });
    expect(screen.queryByText('净利润')).toBeNull();
    expect(screen.queryByText('银行余额')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: '利润' })).toBeNull();
    expect(screen.getByText('本月还没有收入或费用记录')).toBeTruthy();
  });

  it('空数据显示空状态；常用入口为空时只显示“暂无已授权的业务入口”，不渲染没权限的页面', async () => {
    currentUser = userWith(perms([]));
    mockHome(base({ workspace: { type: 'finance', title: '财务工作台', focus: '', positionName: '会计', types: ['finance'] } }));
    renderHome();
    expect(await screen.findByText('没有待办，歇一会儿')).toBeTruthy();
    expect(screen.getByText('没有办理中的申请')).toBeTruthy();
    expect(screen.getByText('暂无已授权的业务入口')).toBeTruthy();
    const entry = screen.getByRole('region', { name: '常用入口' });
    expect(within(entry).queryAllByRole('link')).toHaveLength(0);
  });

  it('常用入口只列有权限且已完成的页面，链接指向导航里的真实路径', async () => {
    currentUser = userWith(perms(['finance.cost-table.view', 'finance.cash-bank.view']));
    mockHome(base({ workspace: { type: 'finance', title: '财务工作台', focus: '', positionName: '会计', types: ['finance'] } }));
    renderHome();
    const entry = await screen.findByRole('region', { name: '常用入口' });
    const links = within(entry).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['成本表', '现金银行查询']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/finance/cost-table', '/finance/cash-bank']);
  });

  it('待办链接：有“我的待办”权限才是链接，没有只显示文字；抄送数跳抄送页', async () => {
    const dto = base({ todos: { pending: 2, overdue: 1, returned: 1, cc: 3, rows: [{ id: 1, runId: 5, title: '借执照-乙', templateLabel: '借用营业执照', stepName: '审批', dueAt: '2026-10-01T00:00:00.000Z', overdue: true, returned: true }] } });
    currentUser = userWith(perms(['workbench.todos.view']));
    mockHome(dto);
    const first = renderHome();
    const card = await screen.findByRole('region', { name: '我的待办' });
    expect(within(card).getByRole('link', { name: '借执照-乙' }).getAttribute('href')).toBe('/workbench/todos?run=5');
    expect(card.querySelector('.pill.warn')?.textContent).toBe('被退回');
    expect(card.querySelector('.pill.bad')?.textContent).toContain('已逾期');
    // 抄送页需要另一项权限，没有就不是链接
    expect(within(card).queryByRole('link', { name: /抄送我的/ })).toBeNull();
    first.unmount();
    currentUser = userWith(perms([]));
    mockHome(dto);
    renderHome();
    const plain = await screen.findByRole('region', { name: '我的待办' });
    expect(within(plain).queryByRole('link')).toBeNull();
    expect(within(plain).getByText('借执照-乙')).toBeTruthy();
  });

  it('运营首页：发起申请、待办、我发起的，没有财务类卡片', async () => {
    currentUser = userWith(perms(['flow.apply.view', 'workbench.started.view']));
    mockHome(base({
      workspace: { type: 'operations', title: '运营工作台', focus: '店铺经营 · SKU 申请', positionName: '运营', types: ['operations'] },
      widgets: ['apply', 'started'],
      apply: { templates: [{ key: 'sku-apply', label: 'SKU 批量申请', description: '一次申请多个规格' }] },
      started: { running: 1, rows: [{ id: 9, title: 'SKU 申请-1', templateLabel: 'SKU 批量申请', requesterName: '我', stepName: '财务核价', handlers: ['财务'], dueAt: null, overdue: false }] },
    }));
    renderHome();
    const apply = await screen.findByRole('region', { name: '发起申请' });
    expect(within(apply).getByRole('link', { name: 'SKU 批量申请' }).getAttribute('href')).toBe('/flow/apply');
    const started = screen.getByRole('region', { name: '我发起的' });
    expect(within(started).getByRole('link', { name: 'SKU 申请-1' }).getAttribute('href')).toBe('/workbench/started?run=9');
    expect(within(started).getByText('不限时')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /本月经营/ })).toBeNull();
  });

  it('读取失败显示原因并可重试；个别卡片失败不影响其余', async () => {
    currentUser = userWith(perms([]));
    apiMock.mockRejectedValueOnce(new ApiError(500, '服务暂时不可用'));
    renderHome();
    expect((await screen.findByRole('alert')).textContent).toContain('服务暂时不可用');
    mockHome(base({ widgets: ['todos'], failed: ['stock'] }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '我的待办' })).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('库存缺货 暂时读取失败');
  });

  it('库存缺货卡片：数量和单位，链到库存查询（有权限时）', async () => {
    currentUser = userWith(perms(['finance.inventory.view']));
    mockHome(base({
      workspace: { type: 'warehouse', title: '仓库工作台', focus: '', positionName: '仓管', types: ['warehouse'] },
      widgets: ['stock'],
      stock: { outCount: 1, rows: [{ productName: '红富士', code: 'HFS', warehouseName: '一号仓', qty: 0, unit: 'KG' }] },
    }));
    renderHome();
    const card = await screen.findByRole('region', { name: '库存缺货' });
    expect(within(card).getByText('红富士')).toBeTruthy();
    expect(within(card).getByRole('link', { name: '库存查询' }).getAttribute('href')).toBe('/finance/inventory');
  });
});
