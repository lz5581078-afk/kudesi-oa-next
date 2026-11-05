vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{id:4,name:'登录中控'},can:()=>true})}));
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleDialog } from './ScheduleDialog';
import { StartDialog } from './StartDialog';
import { liveApi, type ScheduleRow } from './liveApi';
vi.mock('./liveApi', () => ({ liveApi: { checkinContext: vi.fn(), options: vi.fn(), products: vi.fn(), previousSchedule: vi.fn(), createSchedule: vi.fn(), updateSchedule: vi.fn(), start: vi.fn() } }));
const l = vi.mocked(liveApi);
const product = { id: 99, name: '花育25', code: 'HY25', spec: '大包' };
const previous = { id: 1, roomId: 10, roomName: '南1', date: '2026-11-01', startTime: '10:00', endTime: '12:00', anchor: { id: 3, name: '主播甲' }, control: { id: 4, name: '中控乙' }, operator: { id: 5, name: '运营丙' }, douyinAccount: { id: 20, name: '抖音号' }, store: { id: 30, name: '店铺' }, products: [product], note: '上场备注' } as ScheduleRow;
const options = { rooms: [{ id: 10, name: '南1' }], anchors: [{ id: 3, name: '主播甲' }], controls: [{ id: 4, name: '中控乙' }], operators: [{ id: 5, name: '运营丙' }], douyinAccounts: [{ id: 20, name: '抖音号',platform:'douyin',storeIds:[30] }], stores: [{ id: 30, name: '店铺', hasJstShop: true,platform:'douyin' }] };
const open = () => render(<ScheduleDialog initial={null} days={['2026-11-02']} defaultRoom={10} onClose={vi.fn()} onDone={vi.fn()} />);
beforeEach(() => { l.checkinContext.mockResolvedValue({schedules:[],joinable:[]} as never); l.options.mockResolvedValue(options as never); l.products.mockResolvedValue([product]); l.previousSchedule.mockResolvedValue(previous); l.createSchedule.mockResolvedValue({ id: 2 }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('排场产品与上次配置', () => {
  it('新增排场选择单店账号后直接保存，无需第二次勾选', async () => {
    open(); await screen.findByRole('option', {name:/^主播甲/});
    fireEvent.change(screen.getByLabelText('开始时间'),{target:{value:'15:00'}});
    fireEvent.change(screen.getByLabelText('结束时间'),{target:{value:'18:00'}});
    fireEvent.change(screen.getByLabelText('主播'),{target:{value:'3'}});
    fireEvent.change(screen.getByLabelText('中控'),{target:{value:'4'}});
    fireEvent.click(screen.getByRole('checkbox',{name:'抖音号'}));
    expect(screen.queryByRole('checkbox',{name:'抖音号关联店铺'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(l.createSchedule).toHaveBeenCalledWith(expect.objectContaining({channels:[{accountId:20,storeIds:[30]}],roomId:10,anchorId:3})));
  });
  it('试播排班填写本场时薪后才可保存，换主播后清空',async()=>{
    l.options.mockResolvedValue({...options,anchors:[...options.anchors,{id:6,name:'试播乙',trial:true}]} as never);
    render(<ScheduleDialog initial={previous} days={[previous.date]} onClose={vi.fn()} onDone={vi.fn()}/>);
    await screen.findByRole('option',{name:/^试播乙（试播）/});
    const anchor=screen.getByLabelText('主播');
    fireEvent.change(anchor,{target:{value:'6'}});
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    expect(l.updateSchedule).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('本场试播时薪'),{target:{value:'72.50'}});
    fireEvent.change(anchor,{target:{value:'3'}});
    expect(screen.queryByLabelText('本场试播时薪')).toBeNull();
    fireEvent.change(anchor,{target:{value:'6'}});
    expect((screen.getByLabelText('本场试播时薪') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('本场试播时薪'),{target:{value:'72.50'}});
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(l.updateSchedule).toHaveBeenCalledWith(previous.id,expect.objectContaining({anchorId:6,trialHourlyRateCents:7250})));
  });
  it('多店账号未选本场店铺时阻止保存，修改时只保留原选店铺', async () => {
    l.options.mockResolvedValue({...options,douyinAccounts:[{...options.douyinAccounts[0],storeIds:[30,31]}],stores:[...options.stores,{id:31,name:'第二店',platform:'douyin',hasJstShop:true}]} as never);
    render(<ScheduleDialog initial={{...previous,store:null,channels:[{accountId:20,accountName:'抖音号',platform:'douyin',storeIds:[],stores:[]}]}} days={['2026-11-01']} onClose={vi.fn()} onDone={vi.fn()}/>);
    await screen.findByRole('checkbox',{name:'抖音号关联第二店'});
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    expect(screen.getByRole('alert').textContent).toContain('请为「抖音号」选择至少一个本场店铺');
    expect(l.updateSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox',{name:'抖音号关联第二店'}));
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(l.updateSchedule).toHaveBeenCalledWith(1,expect.objectContaining({channels:[{accountId:20,storeIds:[31]}]})));
  });
  it('导入后保留本次日期时间，保存人员、账号、店铺、产品和备注', async () => {
    open();
    await screen.findByRole('option', { name: /^主播甲/ });
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '15:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: '一键导入上次排场' }));
    await screen.findByText(/已导入 2026-11-01/);
    expect(l.previousSchedule).toHaveBeenCalledWith({ roomId: 10, date: '2026-11-02', startTime: '15:00' });
    expect((screen.getByLabelText('主播') as HTMLSelectElement).value).toBe('3');
    expect((screen.getByLabelText('场次产品 1') as HTMLInputElement).value).toBe('花育25（大包）');
    expect(l.products).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(l.createSchedule).toHaveBeenCalledWith({ channels:[{accountId:20,storeIds:[30]}],date: '2026-11-02', roomId: 10, startTime: '15:00', endTime: '18:00', anchorId: 3, controlId: 4, operatorId: 5, douyinAccountId: 20, storeId: 30, productEntries: [{ productId: 99 }], note: '上场备注' }));
  });
  it('导入多平台排场同时保留全部账号店铺和产品',async()=>{
    l.options.mockResolvedValue({...options,douyinAccounts:[...options.douyinAccounts,{id:21,name:'快手号',platform:'kuaishou',storeIds:[31]}],stores:[...options.stores,{id:31,name:'快手店',platform:'kuaishou',hasJstShop:true}]} as never);
    l.previousSchedule.mockResolvedValue({...previous,channels:[{accountId:20,accountName:'抖音号',platform:'douyin',storeIds:[30],stores:[{id:30,name:'店铺',jstShopId:'D'}]},{accountId:21,accountName:'快手号',platform:'kuaishou',storeIds:[31],stores:[{id:31,name:'快手店',jstShopId:'K'}]}]});
    open();await screen.findByRole('option',{name:/^主播甲/});
    fireEvent.change(screen.getByLabelText('开始时间'),{target:{value:'15:00'}});fireEvent.change(screen.getByLabelText('结束时间'),{target:{value:'18:00'}});
    fireEvent.click(screen.getByRole('button',{name:'一键导入上次排场'}));await screen.findByText(/已导入 2026/);
    expect(screen.getByText('快手店')).toBeTruthy();
    expect(screen.queryByRole('checkbox', {name:'快手号关联快手店'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(l.createSchedule).toHaveBeenCalledWith(expect.objectContaining({channels:[{accountId:20,storeIds:[30]},{accountId:21,storeIds:[31]}],productEntries:[{productId:99}]})));
  });
  it('没有上次排场时保持表单，停用人员清空并提醒', async () => {
    l.previousSchedule.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...previous, control: { id: 404, name: '已停用' } });
    open(); await screen.findByRole('option', { name: /^主播甲/ });
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
    await screen.findByRole('option', { name: /^主播甲/ });
    fireEvent.click(screen.getByRole('button', { name: '一键导入上次排场' }));
    fireEvent.change(screen.getByLabelText('排场日期'), { target: { value: '2026-11-03' } });
    resolve(previous);
    await waitFor(() => expect((screen.getByRole('button', { name: '一键导入上次排场' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('主播') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByText(/已导入 2026/)).toBeNull();
  });
  it('修改排场带出产品，可更换并持久保存', async () => {
    render(<ScheduleDialog initial={previous} days={['2026-11-01']} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('option', { name: /^主播甲/ });
    expect(screen.queryByRole('button', { name: '一键导入上次排场' })).toBeNull();
    expect((screen.getByLabelText('场次产品 1') as HTMLInputElement).value).toBe('花育25（大包）');
    fireEvent.click(screen.getByRole('button', { name: '移除场次产品 1' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(l.updateSchedule).toHaveBeenCalledWith(1, expect.objectContaining({ productEntries: [] })));
  });
  it('按排场上播自动选中预排产品', async () => {
    l.start.mockResolvedValue({ id: 6 });
    render(<StartDialog schedule={previous} identity={{isAnchor:true,isControl:false,canManage:false}} onClose={vi.fn()} onDone={vi.fn()} />);
    const dlg = await screen.findByRole('dialog', {name:'报上播（按排场）'});
    await screen.findByText('店铺');
    expect((within(dlg).getByLabelText('场次产品 1') as HTMLInputElement).value).toBe('花育25（大包）');
    expect(l.products).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole('button', { name: '确认上播' }));
    await waitFor(() => expect(l.start).toHaveBeenCalledWith(expect.objectContaining({ productEntries: [{ productId: 99 }], scheduleId: 1 })));
  });
  it('手填多个产品，可加行、删行；保存名称，不请求或伪造编码产品', async () => {
    render(<ScheduleDialog initial={previous} days={['2026-11-01']} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('option', { name: /^主播甲/ });
    expect(screen.queryByLabelText('搜索产品')).toBeNull();
    fireEvent.change(screen.getByLabelText('场次产品 1'), { target: { value: '花育25 大包' } });
    fireEvent.click(screen.getByRole('button', { name: '添加场次产品' }));
    expect(document.activeElement).toBe(screen.getByLabelText('场次产品 2'));
    fireEvent.change(screen.getByLabelText('场次产品 2'), { target: { value: '甜玉米种子' } });
    fireEvent.click(screen.getByRole('button', { name: '添加场次产品' }));
    fireEvent.change(screen.getByLabelText('场次产品 3'), { target: { value: '待移除' } });
    fireEvent.click(screen.getByRole('button', { name: '移除场次产品 3' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(l.updateSchedule).toHaveBeenCalledWith(1, expect.objectContaining({ productEntries: [{ name: '花育25 大包' }, { name: '甜玉米种子' }] })));
    expect(l.products).not.toHaveBeenCalled();
  });
  it('上次排场的手填产品可导入，并按排场带入上播', async () => {
    const manual = { ...previous, products: [{ id: null, code: '', name: '花育25 大包', spec: '' }, { id: null, code: '', name: '甜玉米种子', spec: '' }] };
    l.previousSchedule.mockResolvedValue(manual);
    open(); await screen.findByRole('option', { name: /^主播甲/ });
    fireEvent.click(screen.getByRole('button', { name: '一键导入上次排场' }));
    await screen.findByText(/已导入 2026/);
    expect((screen.getByLabelText('场次产品 1') as HTMLInputElement).value).toBe('花育25 大包');
    expect((screen.getByLabelText('场次产品 2') as HTMLInputElement).value).toBe('甜玉米种子');
    cleanup(); l.start.mockResolvedValue({ id: 8 });
    render(<StartDialog schedule={manual} identity={{ isAnchor:true,isControl:false,canManage:false }} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('店铺');
    fireEvent.click(screen.getByRole('button', { name: '确认上播' }));
    await waitFor(() => expect(l.start).toHaveBeenCalledWith(expect.objectContaining({ productEntries: [{ name: '花育25 大包' }, { name: '甜玉米种子' }], scheduleId: 1 })));
    expect(l.products).not.toHaveBeenCalled();
  });

});

it('缺中控时二次确认，返回不保存，确认后只提交一次',async()=>{
 render(<ScheduleDialog initial={{...previous,control:null}} days={[previous.date]} onClose={vi.fn()} onDone={vi.fn()}/>);
 await screen.findByRole('option',{name:/^主播甲/});
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 expect(screen.getByRole('dialog',{name:'确认未安排中控'})).toBeTruthy();
 expect(l.updateSchedule).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'返回补选'}));
 expect(l.updateSchedule).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 fireEvent.click(screen.getByRole('button',{name:'确认无中控并保存'}));
 await waitFor(()=>expect(l.updateSchedule).toHaveBeenCalledWith(previous.id,expect.objectContaining({controlId:null,anchorId:3})));
 expect(l.updateSchedule).toHaveBeenCalledTimes(1);
});

it('主播未选时提示返回补选，即使中控也未选也不能确认保存',async()=>{
 open();await screen.findByRole('option',{name:/^主播甲/});
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 expect(screen.getByRole('dialog',{name:'请选择本场主播'})).toBeTruthy();
 expect(screen.getByText('中控也尚未选择，请一并核对。')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'确认无中控并保存'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'返回补选主播'}));
 expect(screen.queryByRole('dialog',{name:'请选择本场主播'})).toBeNull();
 expect(l.createSchedule).not.toHaveBeenCalled();
});
