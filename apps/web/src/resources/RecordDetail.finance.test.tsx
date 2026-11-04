import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const formProps = vi.fn();
vi.mock('./RecordForm', () => ({ RecordForm: (p: { initial?: Record<string, unknown> }) => { formProps(p.initial); return <div>表单</div>; }, ReasonDialog: () => null, clearRefCache: () => undefined, loadRefOptions: async () => [] }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, get: vi.fn(), list: vi.fn(), logs: vi.fn().mockResolvedValue([]), relations: vi.fn().mockResolvedValue([]) } };
});
import { RecordDetail, childDefaults, isCurrentCost, isLatestSource } from './RecordDetail';
import {resetUnitOptionsForTest} from './unitOptions';

const dto = (over: Partial<ResourceDto>): ResourceDto => ({ id: 1, type: 'x', title: 'T', status: 'active', statusReason: null, data: {}, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over });
const clip = vi.fn().mockResolvedValue(undefined);
beforeEach(() => { auth.user.permissions={isCompanyAdmin:true,allow:[],deny:[]};Object.assign(navigator, { clipboard: { writeText: clip } }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('商品档案详情：成本汇总', () => {
  it('原料按源显示采购/本档运装/总成本三卡，台账不代替采购价且不添加采购历史', async () => {
    const def = getResourceDef('finance-products')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto({ type: 'finance-products', title: '黄瓜种', data: { archiveType: 'raw', purchaseSpec: '斤', purchasePrice: 1000, freight: 200, handlingFee: 100, totalCost: 1300, latestUnitCost: 1250, latestCostType: 'purchase', latestCostFrom: '2026-10-01' } }));
    const recent = new Date().toISOString();
    vi.mocked(resourceApi.list).mockImplementation(async (t: string) => ({ items: t === 'finance-product-purchase-history' ? [dto({ id: 5, createdAt: recent, data: { purchasePrice: 1000 } }), dto({ id: 4, createdAt: recent, data: { purchasePrice: 800 } })] : [], total: t==='finance-product-purchase-history'?2:0, page: 1, pageSize: 100 }) as never);
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    const box = await screen.findByLabelText('总成本价（含运费、装卸费）');
    expect(box.textContent).toContain('元/斤');
    expect(box.textContent).toContain('¥10');
    expect(box.textContent).toContain('¥13');
    expect(box.textContent).toContain('¥3.000');
    expect(box.querySelectorAll('.product-view-cost-grid>div')).toHaveLength(3);
    expect(box.textContent).not.toContain('采购成本 · 2026-10-01生效');
    expect(screen.queryByRole('button',{name:'历史采购价'})).toBeNull();
  });
  it('无成本查看权限时不渲染源总成本区域', async () => {
    auth.user.permissions={isCompanyAdmin:false,allow:['resource.finance-products.view'],deny:['product.cost.view']};
    vi.mocked(resourceApi.list).mockResolvedValue({items:[],total:0,page:1,pageSize:200});
    const def = getResourceDef('finance-products')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto({ type: 'finance-products', title: '黄瓜种', data: { archiveType: 'raw' } }));
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    await screen.findByText('黄瓜种', { selector: '.rd-title' });
    expect(screen.queryByLabelText('总成本价（含运费、装卸费）')).toBeNull();
  });
});

describe('商品档案详情：源码查看顺序', () => {
  it('原料查看按分类、基础资料、编号排列，无源外赠品设置', async () => {
    const def = getResourceDef('finance-products')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto({ type: 'finance-products', title: '番茄种子', data: { archiveType: 'raw', code: 'YL-1', name: '番茄种子', specQty: 500, specUnit: 'G', purchaseSpec: '斤' } }));
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    await screen.findByText('番茄种子', { selector: '.rd-title' });
    const titles = [...document.querySelectorAll('.finance-view-heading h3')].map(e => e.textContent);
    expect(titles.slice(0,3)).toEqual(['所属分类','基础资料','系统自动编号']);
    expect(screen.queryByRole('region',{name:'赠品简称设置'})).toBeNull();
    expect(screen.getByText('原料名称', { selector: 'dt' })).toBeTruthy();
    expect(screen.getByText('名称单位', { selector: 'dt' })).toBeTruthy();
  });
  it('查看态保留源码的空字段和分区，不受旧通用详情的隐藏空字段偏好影响', async () => {
    localStorage.setItem('kudesi.detail.hideEmpty', '1');
    const def = getResourceDef('finance-products')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto({ type: 'finance-products', title: '番茄种子', data: { archiveType: 'raw', code: 'YL-1', name: '番茄种子', specQty: 500, specUnit: 'G', purchaseSpec: '斤' } }));
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    await screen.findByText('番茄种子', { selector: '.rd-title' });
    expect(screen.getByText('原料生产编码', { selector: 'dt' })).toBeTruthy();
    expect(screen.getByText('未配置')).toBeTruthy();
    expect(screen.queryByLabelText('隐藏空字段')).toBeNull();
    expect(screen.queryByText('编辑本区')).toBeNull();
    localStorage.removeItem('kudesi.detail.hideEmpty');
  });
});

describe('详情里的复制', () => {
  it('供应商：收款账号逐项复制，并能一键复制整组银行信息', async () => {
    const def = getResourceDef('finance-suppliers')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto({ type: 'finance-suppliers', title: '润农', data: { code: 'GYS-001', bankAccountName: '润农公司', bank: '工行', bankAccountNo: '6222000011112222' } }));
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '复制收款账号' }));
    expect(clip).toHaveBeenCalledWith('6222000011112222');
    fireEvent.click(screen.getByRole('button', { name: '复制全部银行信息' }));
    expect(clip).toHaveBeenLastCalledWith('供应商名称：润农\n账户名称：润农公司\n开户行：工行\n银行账号：6222000011112222');
    fireEvent.click(screen.getByRole('button', { name: '复制供应商编号' }));
    expect(clip).toHaveBeenLastCalledWith('GYS-001');
  });
});

describe('成本明细行', () => {
  it('新增默认：采购成本、商品规格单位、今天生效、手工锁定并带原因；编辑时不带默认', () => {
    const parent = dto({ data: { purchaseSpec: '500g/袋',specUnit:'斤' } });
    const d = childDefaults('finance-product-costs', true, parent);
    expect(d).toMatchObject({ costType: 'purchase', unitName: '斤', manualOverride: true, manualLockReason: '人工确认成本' });
    expect(String(d.effectiveFrom)).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(childDefaults('finance-product-costs', false, parent)).toEqual({});
    expect(childDefaults('finance-product-boms', true, parent)).toEqual({});
  });
  it('默认取真实名称单位kind，不把采购规格或同码另一单位当名称；既有成本不带默认',()=>{
    resetUnitOptionsForTest({archive_unit:[{value:'KG',label:'档案千克'}],spec_unit:[{value:'KG',label:'编码公斤'}]});
    try{const parent=dto({data:{purchaseSpec:'500g/袋',specUnit:'KG',unitDictionaryKind:'archive_unit'}});expect(childDefaults('finance-product-costs',true,parent).unitName).toBe('档案千克');expect(childDefaults('finance-product-costs',false,parent)).toEqual({});}finally{resetUnitOptionsForTest();}
  });
  it('同一成本类型里生效日最新、已开始且未结束的一条标“当前生效”', () => {
    const mk = (id: number, from: string, to?: string, type = 'purchase') => dto({ id, data: { costType: type, effectiveFrom: from, effectiveTo: to ?? '' } });
    const all = [mk(1, '2020-01-01', '2020-12-31'), mk(2, '2021-01-01'), mk(3, '2022-01-01'), mk(4, '2999-01-01'), mk(5, '2021-06-01', undefined, 'express')];
    expect(all.filter((x) => isCurrentCost(x, all)).map((x) => x.id)).toEqual([3, 5]);
  });
});

describe('供货来源：当前最新成本', () => {
  const src = (id: number, updatedAt: string, status = 'active') => ({ id, status, updatedAt, data: {} }) as never;
  it('旧数据按更新时间回退；只有一条或已停用的不标', () => {
    const a = src(1, '2026-01-01'), b = src(2, '2026-03-01'), c = src(3, '2026-05-01', 'inactive');
    const all = [a, b, c];
    expect(isLatestSource(b, all)).toBe(true);
    expect(isLatestSource(a, all)).toBe(false);
    expect(isLatestSource(c, all)).toBe(false);
    expect(isLatestSource(a, [a])).toBe(false);
  });
  it('改产区等资料不会抢占采购价较新的来源', () => {
    const older = dto({ id: 1, updatedAt: '2026-04-01', data: { priceUpdatedAt: '2026-01-01' } });
    const newer = dto({ id: 2, updatedAt: '2026-03-01', data: { priceUpdatedAt: '2026-03-01' } });
    expect(isLatestSource(newer, [older, newer])).toBe(true);
    expect(isLatestSource(older, [older, newer])).toBe(false);
  });

});
