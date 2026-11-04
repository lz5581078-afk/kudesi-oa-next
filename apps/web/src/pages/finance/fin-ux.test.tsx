import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker } from '@kudesi/shared';
import { DocForm } from './DocForm';
import { DocumentsPage } from './DocumentsPage';
import { FinanceOverviewPage } from './FinanceOverviewPage';
import { CopyButton, DATE_PRESETS, activePreset } from './fin-ui';
import { financeApi } from './financeApi';
import { resourceApi } from '../../resources/api';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: '测试员' }, loading: false, can: createChecker({ isCompanyAdmin: true, allow: [], deny: [] }) }),
}));
vi.mock('./financeApi', () => ({
  financeApi: { overview: vi.fn(), docs: vi.fn(), banks: vi.fn(), doc: vi.fn(), openItems: vi.fn(), syncEmployees: vi.fn(), create: vi.fn(), issue: vi.fn(), post: vi.fn(), update: vi.fn() },
}));
vi.mock('../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../resources/api')>()), resourceApi: { list: vi.fn(), get: vi.fn() } }));
const fa = vi.mocked(financeApi);
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.clearAllMocks(); window.localStorage.clear();
  // Range labels are distinct mid-month; keep real timers for async UI checks.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
});
afterEach(() => { vi.unstubAllGlobals(); cleanup(); vi.useRealTimers(); });

const emptyList = { total: 0, amountCents: 0, paidCents: 0, page: 1, pageSize: 20, rows: [] };

describe('日期快捷区间', () => {
  it('今天/近7天/本月/上月/全部 都能被识别回来', () => {
    for (const p of DATE_PRESETS) { const [a, b] = p.range(); expect(activePreset(a, b)).toBe(p.key); }
  });
  it('月初与第7天区间重叠时，保持现有快捷项顺序的优先级', () => {
    const month = DATE_PRESETS.find(p => p.key === 'month')!;
    for (const [day, expected] of [['01', 'today'], ['07', '7d']]) {
      vi.setSystemTime(new Date(`2026-03-${day}T12:00:00Z`));
      const [from, to] = month.range(); expect(activePreset(from, to)).toBe(expected);
    }
  });
});

describe('复制按钮', () => {
  it('点一下把文字写进剪贴板并显示已复制', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    render(<CopyButton text="XS20260101001" label="单号" />);
    fireEvent.click(screen.getByRole('button', { name: '复制单号' }));
    await screen.findByText('已复制');
    expect(write).toHaveBeenCalledWith('XS20260101001');
  });
});

describe('经营历程 / 草稿中心筛选', () => {
  it('默认当天且不保留新版期间快捷筛选，每次打开重新初始化', async () => {
    fa.docs.mockResolvedValue(emptyList);
    const first=render(<MemoryRouter><DocumentsPage scope="history"/></MemoryRouter>);
    await waitFor(()=>expect(fa.docs).toHaveBeenCalled());
    expect(screen.getByLabelText('开始日期')).toHaveProperty('value','2026-03-15');
    fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-03-01'}});
    expect(fa.docs).toHaveBeenCalledTimes(1);first.unmount();
    render(<MemoryRouter><DocumentsPage scope="history"/></MemoryRouter>);
    expect(screen.getByLabelText('开始日期')).toHaveProperty('value','2026-03-15');
    expect(screen.queryByRole('button',{name:'本月'})).toBeNull();
  });
  it('原汇总不增加下钻按钮，筛选和重置在完整数据上生效', async () => {
    fa.docs.mockResolvedValue({...emptyList,total:2,rows:[
      {id:1,docNo:'XS1',docType:'sale',typeLabel:'普通销售单',status:'posted',docDate:'2026-03-15',amountCents:100,direction:'in'},
      {id:2,docNo:'FY1',docType:'expense',typeLabel:'费用单',status:'posted',docDate:'2026-03-15',amountCents:50,direction:'out'},
    ]} as never);
    render(<MemoryRouter><DocumentsPage scope="history"/></MemoryRouter>);await screen.findByText('XS1');
    expect(screen.queryByRole('button',{name:/收入合计/})).toBeNull();
    fireEvent.change(screen.getByLabelText('收支方向'),{target:{value:'out'}});
    expect(screen.queryByText('XS1')).toBeNull();expect(screen.getByText('FY1')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('关键词'),{target:{value:'不存在'}});
    expect(screen.getAllByRole('row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'重置'}));
    expect(screen.getByText('XS1')).toBeTruthy();expect(screen.getByLabelText('开始日期')).toHaveProperty('value','');
    expect(fa.docs).toHaveBeenCalledTimes(1);
  });
  it('草稿编号恢复主文本，操作来自查看草稿，不另加复制按钮', async () => {
    fa.docs.mockResolvedValue({...emptyList,total:1,rows:[{id:1,docNo:'FK1',docType:'payment',typeLabel:'付款单',status:'draft',docDate:'2026-03-10',amountCents:100,paidCents:0,bankName:null,handler:null,auditedAt:null,createdBy:1,memo:null,reversesId:null,partyName:null,createdByName:'老板'}]} as never);
    render(<MemoryRouter><DocumentsPage scope="drafts"/></MemoryRouter>);
    expect(await screen.findByText('FK1')).toBeTruthy();
    expect(screen.getByRole('button',{name:'查看草稿'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'复制单号 FK1'})).toBeNull();
  });
});

describe('财务经营', () => {
  it('恢复原经营中心三面板和四列店铺表，不显示额外汇总和日期筛选', async () => {
    fa.overview.mockResolvedValue({ stores:[{storeId:1,name:'甲店',platform:'pdd',licenseName:'合成主体',salesCents:10000,profitCents:2500}],storeTrend:[],ledger:[] } as never);
    render(<MemoryRouter><FinanceOverviewPage/></MemoryRouter>);
    await screen.findByText('pdd / 甲店');
    expect(fa.overview).toHaveBeenCalledWith('all');
    expect(screen.getByRole('heading',{name:'财务经营中心'})).toBeTruthy();
    expect(screen.getByRole('region',{name:'利润趋势'})).toBeTruthy();
    expect(screen.getByRole('region',{name:'店铺利润'})).toBeTruthy();
    expect(screen.getByRole('region',{name:'财务台账'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:/销售收入/})).toBeNull();
    expect(screen.queryByLabelText('月份')).toBeNull();
    expect(screen.queryByLabelText('开始日期')).toBeNull();
  });
  it('店铺利润显示原四列，利润金额保留而不额外增加利润率列', async () => {
    fa.overview.mockResolvedValue({ stores:[{storeId:1,name:'甲店',platform:'pdd',salesCents:10000,profitCents:2500}],storeTrend:[],ledger:[] } as never);
    render(<MemoryRouter><FinanceOverviewPage/></MemoryRouter>);
    expect(await screen.findByText('¥25.00')).toBeTruthy();
    expect(screen.queryByRole('columnheader',{name:'利润率'})).toBeNull();
    expect(screen.queryByRole('columnheader',{name:'推广费'})).toBeNull();
  });
});

describe('开单页细节', () => {
  const stock = (type: string) => ({ items: [{ id: 7, title: type === 'bank-accounts' ? '现金户' : '老客户', status: 'active', data: {}, type }], total: 1, page: 1, pageSize: 15 });
  beforeEach(() => {
    vi.mocked(resourceApi.list).mockImplementation((async (type: string) => stock(type)) as never);
    fa.banks.mockResolvedValue([{ id: 7, title: '现金户', kind: 'cashier_account', status: 'normal', openingCents: 0, movementCents: 0, balanceCents: 1000, entries: 0 }]);
  });
  it('付款单：选了付款账户后显示账户余额和付后余额；余额为负时过账前确认并可取消', async () => {
    fa.create.mockResolvedValue({ id: 1, docNo: 'FK1' } as never);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DocForm type="payment" onSaved={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('付款账户'));
    fireEvent.click(await screen.findByRole('option', { name: '现金户' }));
    fireEvent.change(screen.getByLabelText('第1行金额'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/^第1行(?!金额|备注)/), { target: { value: '货款' } });
    const hint = await screen.findByLabelText('账户余额预览');
    expect(hint.textContent).toContain('¥10.00');
    expect(hint.textContent).toContain('¥-40.00');
    fireEvent.click(screen.getByLabelText('收款方'));
    fireEvent.click(await screen.findByRole('option', { name: '老客户' }));
    fireEvent.click(screen.getByRole('button', { name: '保存并开立' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(String(confirm.mock.calls[0][0])).toContain('余额不足');
    expect(fa.create).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
  it('商品明细：最后一行按回车自动加一行；只剩一行时删除变成清空', async () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    const before = screen.getAllByLabelText(/行单价$/).length;
    fireEvent.keyDown(screen.getAllByLabelText(/行备注$/)[before - 1], { key: 'Enter' });
    await waitFor(() => expect(screen.getAllByLabelText(/行单价$/).length).toBe(before + 1));
    expect(screen.getByText(/共 0 种商品/)).toBeTruthy();
    cleanup();
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getAllByRole('button', { name: /^删除第1行$/ })[0]);
    expect(screen.getAllByLabelText(/行单价$/).length).toBe(1);
    expect(screen.getByRole('button', { name: '删除第1行' }).textContent).toBe('清空');
  });
  it('收款金额比单据少时提示还差多少未结清；底部一直显示本单合计', async () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('第1行数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('第1行单价'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '收了部分款' }));
    fireEvent.change(screen.getByLabelText('收到金额', { selector: 'input' }), { target: { value: '5' } });
    expect((await screen.findByText(/本单还差 ¥15.00 未结清/)).textContent).toContain('挂应收');
    expect(document.querySelector('.slip-total-card')!.textContent).toContain('¥20.00');
  });
  it('转款单：能互换转出/转入账户', async () => {
    render(<DocForm type="transfer" inline onSaved={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('添加转出账户'));
    fireEvent.click(await screen.findByRole('option', { name: '现金户' }));
    expect(screen.getByText('还没有选转入账户')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /互换转出\/转入/ }));
    expect(screen.getByText('还没有选转出账户')).toBeTruthy();
  });
});
