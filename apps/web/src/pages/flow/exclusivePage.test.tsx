import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExclusivePage } from './ExclusivePage';
import { flowApi } from './flowApi';
import { exclusiveApi } from './exclusiveApi';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('./RunDetail', () => ({ RunDetail: ({ id }: { id: number }) => <div>流程详情 #{id}</div> }));
vi.mock('./flowApi', async (orig) => ({ ...(await orig<typeof import('./flowApi')>()), flowApi: { start: vi.fn() } }));
vi.mock('./exclusiveApi', () => ({ exclusiveApi: { options: vi.fn(), grants: vi.fn(), cancel: vi.fn() } }));
const ex = vi.mocked(exclusiveApi);
const flow = vi.mocked(flowApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const options = {
  total: 3, free: 1, capped: false,
  categories: [{ id: 1, name: '水果', parentId: null }],
  rows: [
    { id: 11, code: 'SG001', name: '红富士', categoryId: 1, categoryName: '水果', exclusive: null, pending: null },
    { id: 12, code: 'SG002', name: '青苹果', categoryId: 1, categoryName: '水果', exclusive: { ownerName: '小乙', endsAt: '2027-01-01T12:00:00.000Z', mine: false }, pending: null },
    { id: 13, code: 'SG003', name: '黄元帅', categoryId: 1, categoryName: '水果', exclusive: null, pending: { runId: 5, requesterName: '小丙', mine: false } },
  ],
};
const grant = { id: 3, productName: '红富士', ownerName: '小甲', approverName: '审批人', runId: 9, startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z', status: 'active' as const, cancelReason: '', cancelledAt: null, canCancel: true };

describe('专属品领取页', () => {
  it('不可领取的商品点不了；缺项时提示；确认摘要后才提交，提交后打开流程详情', async () => {
    ex.options.mockResolvedValue(options);
    flow.start.mockResolvedValue({ id: 88 } as never);
    render(<ExclusivePage />);
    await screen.findByText('红富士');
    expect(screen.getByText(/共 3 个商品，其中可领取 1 个/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /青苹果/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /黄元帅/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('小乙专属，至2027-01-01')).toBeTruthy();
    expect(screen.getByText('小丙申请中')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '提交领取申请' }));
    expect(screen.getByText(/还有 2 项没填好/)).toBeTruthy();
    expect(flow.start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /红富士/ }));
    fireEvent.change(screen.getByLabelText('领取原因'), { target: { value: '计划做直播专场' } });
    fireEvent.click(screen.getByRole('button', { name: '提交领取申请' }));
    const dlg = screen.getByRole('dialog', { name: '确认提交领取申请' });
    expect(dlg.textContent).toContain('红富士（SG001）');
    expect(dlg.textContent).toContain('计划做直播专场');
    expect(flow.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认提交申请' }));
    await screen.findByText('流程详情 #88');
    expect(flow.start).toHaveBeenCalledWith('product-exclusive', { baseCodeId: 11, reason: '计划做直播专场' }, expect.any(String));
  });

  it('搜索、分类和“只看可领取”会带给服务端；清除筛选恢复', async () => {
    ex.options.mockResolvedValue(options);
    render(<ExclusivePage />);
    await screen.findByText('红富士');
    fireEvent.change(screen.getByLabelText('搜索基础商品'), { target: { value: '苹果' } });
    fireEvent.change(screen.getByLabelText('商品分类'), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText(/只看可领取/));
    await waitFor(() => expect(ex.options).toHaveBeenLastCalledWith({ keyword: '苹果', categoryId: 1, onlyFree: true }));
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    await waitFor(() => expect(ex.options).toHaveBeenLastCalledWith({ keyword: undefined, categoryId: undefined, onlyFree: false }));
  });

  it('专属记录与历史：取消必须写原因，写了才调用接口', async () => {
    ex.options.mockResolvedValue(options);
    ex.grants.mockResolvedValue({ rows: [grant, { ...grant, id: 4, productName: '旧品', status: 'cancelled', canCancel: false, cancelReason: '不做了' }] });
    ex.cancel.mockResolvedValue({ ok: true });
    render(<ExclusivePage />);
    fireEvent.click(screen.getByRole('tab', { name: '专属品管理与历史' }));
    await screen.findByText('专属生效中');
    expect(screen.getByText(/取消原因：不做了/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '取消专属' }).length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '取消专属' }));
    fireEvent.click(screen.getByRole('button', { name: '确认取消专属' }));
    expect(await screen.findByText(/需要填写原因/)).toBeTruthy();
    expect(ex.cancel).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('取消原因'), { target: { value: '换品牌了' } });
    fireEvent.click(screen.getByRole('button', { name: '确认取消专属' }));
    await waitFor(() => expect(ex.cancel).toHaveBeenCalledWith(3, '换品牌了'));
  });
});
