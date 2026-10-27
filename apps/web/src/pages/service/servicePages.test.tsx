import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { AppealsPage } from './AppealsPage';
import { SupervisionPage } from './SupervisionPage';

vi.mock('../../api/client', async (orig) => ({ ...(await orig<typeof import('../../api/client')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);
const stats = { open: 2, late: 1, soon: 0, toSubmit: 1, awaiting: 0, monthReconsider: 1, canReconsider: 0, openAmountCents: 0 };
const summary = { asOf: '2026-10-27T00:00:00Z', afterSales: { open: 3, overdue: 1, dueSoon: 0, openAmountCents: 1000, overdueAmountCents: 500 }, appeals: { open: 2, overdue: 0, dueSoon: 0, toSubmit: 1, openAmountCents: 0 }, tasks: { pending: 4, overdue: 2, completed: 1, total: 5 }, flows: { running: 6, overdue: 1 }, exceptions: { open: 1, urgent: 1, escalated: 0 } };
const rule = { targetType: 'after_sales', name: '售后工单超时', overdueMinutes: 0, supervisorVisibleMinutes: 0, bossVisibleMinutes: 1440, abnormalCondition: '超时', closeRequiresReason: true, status: 'active' };
const exception = { id: 1, sourceType: 'manual', sourceId: null, runId: null, title: '仓库漏发', detail: null, severity: 'urgent', status: 'open', level: 2, ownerId: null, ownerName: '', storeName: '', dueAt: null, createdAt: '2026-10-26T00:00:00Z', escalatedAt: null, closeReason: null, closedByName: '', closedAt: null, canClose: true };

beforeEach(() => {
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path.startsWith('/appeals/stores')) return [{ id: 7, name: '旗舰店', status: 'normal', platform: '淘宝', storeNo: 'T1', operatorName: '小王', open: 2, late: 1 }];
    if (path.startsWith('/appeals')) return { total: 0, page: 1, pageSize: 20, stats, rows: [] };
    if (path.startsWith('/after-sales/stores')) return [];
    if (path.startsWith('/supervision/exceptions/1/close')) return { ok: true };
    if (path.startsWith('/supervision/exceptions/1')) return { logs: [] };
    if (path.startsWith('/supervision')) return { asOf: summary.asOf, summary, exceptions: [exception], closed: [], people: [], assignmentAlerts: [], rules: [rule], canManage: true };
    void opts;
    return {};
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('订单申诉', () => {
  it('先列经营中店铺，点“申诉”进入工作台并显示本月复议和空记录提示', async () => {
    render(<MemoryRouter><AppealsPage /></MemoryRouter>);
    await screen.findByText('旗舰店');
    fireEvent.click(screen.getByRole('button', { name: '申诉' }));
    await screen.findByText('旗舰店 / 订单申诉');
    await screen.findByText('1/3');
    expect(await screen.findByText('还没有申诉记录')).toBeTruthy();
    expect(screen.getAllByText('去申诉').length).toBeGreaterThanOrEqual(8);
  });
});

describe('兜底监督', () => {
  it('显示汇总和异常；关闭异常必须写原因', async () => {
    render(<MemoryRouter><SupervisionPage /></MemoryRouter>);
    const row = await screen.findByLabelText('异常 仓库漏发');
    expect(within(row).getByText('紧急')).toBeTruthy();
    fireEvent.click(within(row).getByText('处理'));
    const dlg = await screen.findByRole('dialog', { name: '异常详情' });
    fireEvent.click(within(dlg).getByText('关闭异常'));
    fireEvent.click(within(dlg).getByText('确认关闭'));
    expect(await within(dlg).findByText('关闭异常必须写原因')).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText('关闭原因'), { target: { value: '已补发' } });
    fireEvent.click(within(dlg).getByText('确认关闭'));
    await waitFor(() => expect(apiMock.mock.calls.some(([p]) => String(p).includes('/close'))).toBe(true));
  });
  it('规则可编辑，老板可见时间不能早于主管', async () => {
    render(<MemoryRouter><SupervisionPage /></MemoryRouter>);
    await screen.findByText('售后工单超时');
    fireEvent.click(screen.getByText('编辑'));
    fireEvent.change(screen.getByLabelText('主管可见（分钟）'), { target: { value: '2000' } });
    fireEvent.click(screen.getByText('保存'));
    expect(await screen.findByText('老板可见时间不能早于主管可见时间')).toBeTruthy();
  });
});
