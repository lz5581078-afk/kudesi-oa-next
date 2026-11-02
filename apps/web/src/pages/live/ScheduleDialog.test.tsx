import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleDialog } from './ScheduleDialog';
import { StartDialog } from './StartDialog';
import { liveApi, type ScheduleRow } from './liveApi';
vi.mock('./liveApi', () => ({ liveApi: { options: vi.fn(), products: vi.fn(), previousSchedule: vi.fn(), createSchedule: vi.fn(), updateSchedule: vi.fn(), start: vi.fn() } }));
const l = vi.mocked(liveApi);
const product = { id: 99, name: '花育25', code: 'HY25', spec: '大包' };
const previous = { id: 1, roomId: 10, roomName: '南1', date: '2026-11-01', startTime: '10:00', endTime: '12:00', anchor: { id: 3, name: '主播甲' }, control: { id: 4, name: '中控乙' }, operator: { id: 5, name: '运营丙' }, douyinAccount: { id: 20, name: '抖音号' }, store: { id: 30, name: '店铺' }, products: [product], note: '上场备注' } as ScheduleRow;
const options = { rooms: [{ id: 10, name: '南1' }], anchors: [{ id: 3, name: '主播甲' }], controls: [{ id: 4, name: '中控乙' }], operators: [{ id: 5, name: '运营丙' }], douyinAccounts: [{ id: 20, name: '抖音号',platform:'douyin',storeIds:[30] }], stores: [{ id: 30, name: '店铺', hasJstShop: true,platform:'douyin' }] };
const open = () => render(<ScheduleDialog initial={null} days={['2026-11-02']} defaultRoom={10} onClose={vi.fn()} onDone={vi.fn()} />);
beforeEach(() => { l.options.mockResolvedValue(options as never); l.products.mockResolvedValue([product]); l.previousSchedule.mockResolvedValue(previous); l.createSchedule.mockResolvedValue({ id: 2 }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('排场产品与上次配置', () => {
  it('导入后保留本次日期时间，保存人员、账号、店铺、产品和备注', async () => {
    open();
    await screen.findByRole('option', { name: '主播甲' });
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '15:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: '一键导入上次排场' }));
    await screen.findByText(/已导入 2026-11-01/);
    expect(l.previousSchedule).toHaveBeenCalledWith({ roomId: 10, date: '2026-11-02', startTime: '15:00' });
    expect((screen.getByLabelText('主播') as HTMLSelectElement).value).toBe('3');
    expect(screen.getByLabelText('已选产品').textContent).toContain('花育25');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(l.createSchedule).toHaveBeenCalledWith({ channels:[{accountId:20,storeIds:[30]}],date: '2026-11-02', roomId: 10, startTime: '15:00', endTime: '18:00', anchorId: 3, controlId: 4, operatorId: 5, douyinAccountId: 20, storeId: 30, productIds: [99], note: '上场备注' }));
  });
  it('导入多平台排场同时保留全部账号店铺和产品',async()=>{
    l.options.mockResolvedValue({...options,douyinAccounts:[...options.douyinAccounts,{id:21,name:'快手号',platform:'kuaishou',storeIds:[31]}],stores:[...options.stores,{id:31,name:'快手店',platform:'kuaishou',hasJstShop:true}]} as never);
    l.previousSchedule.mockResolvedValue({...previous,channels:[{accountId:20,accountName:'抖音号',platform:'douyin',storeIds:[30],stores:[{id:30,name:'店铺',jstShopId:'D'}]},{accountId:21,accountName:'快手号',platform:'kuaishou',storeIds:[31],stores:[{id:31,name:'快手店',jstShopId:'K'}]}]});
    open();await screen.findByRole('option',{name:'主播甲'});
    fireEvent.change(screen.getByLabelText('开始时间'),{target:{value:'15:00'}});fireEvent.change(screen.getByLabelText('结束时间'),{target:{value:'18:00'}});
    fireEvent.click(screen.getByRole('button',{name:'一键导入上次排场'}));await screen.findByText(/已导入 2026/);
    expect((screen.getByLabelText('快手号关联快手店') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(l.createSchedule).toHaveBeenCalledWith(expect.objectContaining({channels:[{accountId:20,storeIds:[30]},{accountId:21,storeIds:[31]}],productIds:[99]})));
  });
  it('没有上次排场时保持表单，停用人员清空并提醒', async () => {
    l.previousSchedule.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...previous, control: { id: 404, name: '已停用' } });
    open(); await screen.findByRole('option', { name: '主播甲' });
    fireEvent.click(screen.getByRole('button', { name: '一键导入上次排场' }));
    await screen.findByText(/没有可导入的排场/);
    fireEvent.click(screen.getByRole('button', { name: '一键导入上次排场' }));
    await screen.findByText(/部分人员或账号已停用/);
    expect((screen.getByLabelText('中控') as HTMLSelectElement).value).toBe('');
  });
  it('切换日期后丢弃旧导入结果', async () => {
    let resolve!: (v: ScheduleRow) => void;
    l.previousSchedule.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<ScheduleDialog initial={null} days={['2026-11-02', '2026-11-03']} defaultRoom={10} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('option', { name: '主播甲' });
    fireEvent.click(screen.getByRole('button', { name: '一键导入上次排场' }));
    fireEvent.change(screen.getByLabelText('排场日期'), { target: { value: '2026-11-03' } });
    resolve(previous);
    await waitFor(() => expect((screen.getByRole('button', { name: '一键导入上次排场' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('主播') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByText(/已导入 2026/)).toBeNull();
  });
  it('修改排场带出产品，可更换并持久保存', async () => {
    render(<ScheduleDialog initial={previous} days={['2026-11-01']} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('option', { name: '主播甲' });
    expect(screen.queryByRole('button', { name: '一键导入上次排场' })).toBeNull();
    const list = await screen.findByLabelText('HY25 · 花育25 · 大包');
    expect((list as HTMLInputElement).checked).toBe(true);
    fireEvent.click(list); fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(l.updateSchedule).toHaveBeenCalledWith(1, expect.objectContaining({ productIds: [] })));
  });
  it('按排场上播自动选中预排产品', async () => {
    l.start.mockResolvedValue({ id: 6 });
    render(<StartDialog schedule={previous} identity={{isAnchor:true,isControl:false,canManage:false}} onClose={vi.fn()} onDone={vi.fn()} />);
    const dlg = await screen.findByRole('dialog');
    await screen.findByLabelText('抖音号关联店铺');
    expect(within(dlg).getByLabelText('已选产品').textContent).toContain('HY25');
    fireEvent.click(within(dlg).getByRole('button', { name: '确认上播' }));
    await waitFor(() => expect(l.start).toHaveBeenCalledWith(expect.objectContaining({ productIds: [99], scheduleId: 1 })));
  });
});
