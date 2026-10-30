import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const formProps = vi.fn();
vi.mock('./RecordForm', () => ({ RecordForm: (p: { initial?: Record<string, unknown> }) => { formProps(p.initial); return <div>表单</div>; }, ReasonDialog: () => null, clearRefCache: () => undefined, loadRefOptions: async () => [] }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, get: vi.fn(), list: vi.fn(), logs: vi.fn().mockResolvedValue([]), relations: vi.fn().mockResolvedValue([]) } };
});
import { RecordDetail, childDefaults, isCurrentCost, isLatestSource } from './RecordDetail';

const dto = (over: Partial<ResourceDto>): ResourceDto => ({ id: 1, type: 'x', title: 'T', status: 'active', statusReason: null, data: {}, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over });
const clip = vi.fn().mockResolvedValue(undefined);
beforeEach(() => { Object.assign(navigator, { clipboard: { writeText: clip } }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('商品档案详情：成本汇总', () => {
  it('显示 采购价 + 运费 + 装卸费 = 总成本价，上次采购价和 3 个月平均采购价取自历史', async () => {
    const def = getResourceDef('finance-products')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto({ type: 'finance-products', title: '黄瓜种', data: { archiveType: 'raw', purchaseSpec: '斤', purchasePrice: 1000, freight: 200, handlingFee: 100, totalCost: 1300, latestUnitCost: 1250, latestCostType: 'purchase', latestCostFrom: '2026-10-01' } }));
    const recent = new Date().toISOString();
    vi.mocked(resourceApi.list).mockImplementation(async (t: string) => ({ items: t === 'finance-product-freight-history' ? [dto({ id: 5, createdAt: recent, data: { purchasePrice: 1000 } }), dto({ id: 4, createdAt: recent, data: { purchasePrice: 800 } })] : [], total: 2, page: 1, pageSize: 100 }) as never);
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    const box = await screen.findByLabelText('成本汇总');
    expect(box.textContent).toContain('元/斤');
    expect(box.textContent).toContain('¥10');
    expect(box.textContent).toContain('¥13');
    expect(box.textContent).toContain('采购成本 · 2026-10-01生效');
    await waitFor(() => expect(box.textContent).toContain('¥9'));
  });
  it('没有成本字段（无成本权限）时不显示成本汇总', async () => {
    const def = getResourceDef('finance-products')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto({ type: 'finance-products', title: '黄瓜种', data: { archiveType: 'raw' } }));
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    await screen.findByText('黄瓜种', { selector: '.rd-title' });
    expect(screen.queryByLabelText('成本汇总')).toBeNull();
  });
});

describe('商品档案详情：分区和新增/编辑表单同一份布局', () => {
  it('原料详情按布局的分区顺序、旧版叫法显示（原料名称、规格、名称单位）', async () => {
    const def = getResourceDef('finance-products')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto({ type: 'finance-products', title: '番茄种子', data: { archiveType: 'raw', code: 'YL-1', name: '番茄种子', specQty: 500, specUnit: 'G', purchaseSpec: '斤' } }));
    localStorage.setItem('kudesi.detail.hideEmpty', '0'); // 这条只看分区顺序：显示空字段
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    await screen.findByText('番茄种子', { selector: '.rd-title' });
    const titles = [...document.querySelectorAll('.rd-sec-title')].map((e) => (e.textContent ?? '').replace(/编辑本区$/, ''));
    expect(titles.slice(0, 4)).toEqual(['所属分类', '系统自动编号', '赠品简称设置', '原料基础信息']);
    expect(screen.getByText('原料名称', { selector: 'dt' })).toBeTruthy();
    expect(screen.getByText('名称单位', { selector: 'dt' })).toBeTruthy();
    localStorage.removeItem('kudesi.detail.hideEmpty');
  });
  it('没设过偏好时商品详情默认藏起空字段（只剩有内容的分区）；勾掉后才显示', async () => {
    localStorage.removeItem('kudesi.detail.hideEmpty');
    const def = getResourceDef('finance-products')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto({ type: 'finance-products', title: '番茄种子', data: { archiveType: 'raw', code: 'YL-1', name: '番茄种子', specQty: 500, specUnit: 'G', purchaseSpec: '斤' } }));
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    await screen.findByText('番茄种子', { selector: '.rd-title' });
    expect(screen.queryByText('赠品简称', { selector: 'dt' })).toBeNull();
    expect((screen.getByLabelText('隐藏空字段') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('隐藏空字段'));
    expect(screen.getByText('赠品简称', { selector: 'dt' })).toBeTruthy();
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
    expect(clip).toHaveBeenLastCalledWith('户名：润农公司\n开户行：工行\n账号：6222000011112222');
    fireEvent.click(screen.getByRole('button', { name: '复制供应商编号' }));
    expect(clip).toHaveBeenLastCalledWith('GYS-001');
  });
});

describe('成本明细行', () => {
  it('新增默认：采购成本、商品规格单位、今天生效、手工锁定并带原因；编辑时不带默认', () => {
    const parent = dto({ data: { purchaseSpec: '斤' } });
    const d = childDefaults('finance-product-costs', true, parent);
    expect(d).toMatchObject({ costType: 'purchase', unitName: '斤', manualOverride: true, manualLockReason: '人工确认成本' });
    expect(String(d.effectiveFrom)).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(childDefaults('finance-product-costs', false, parent)).toEqual({});
    expect(childDefaults('finance-product-boms', true, parent)).toEqual({});
  });
  it('同一成本类型里生效日最新、已开始且未结束的一条标“当前生效”', () => {
    const mk = (id: number, from: string, to?: string, type = 'purchase') => dto({ id, data: { costType: type, effectiveFrom: from, effectiveTo: to ?? '' } });
    const all = [mk(1, '2020-01-01', '2020-12-31'), mk(2, '2021-01-01'), mk(3, '2022-01-01'), mk(4, '2999-01-01'), mk(5, '2021-06-01', undefined, 'express')];
    expect(all.filter((x) => isCurrentCost(x, all)).map((x) => x.id)).toEqual([3, 5]);
  });
});

describe('供货来源：当前最新成本', () => {
  const src = (id: number, updatedAt: string, status = 'active') => ({ id, status, updatedAt, data: {} }) as never;
  it('启用来源里最近更新的一条标最新；只有一条或已停用的不标', () => {
    const a = src(1, '2026-01-01'), b = src(2, '2026-03-01'), c = src(3, '2026-05-01', 'inactive');
    const all = [a, b, c];
    expect(isLatestSource(b, all)).toBe(true);
    expect(isLatestSource(a, all)).toBe(false);
    expect(isLatestSource(c, all)).toBe(false);
    expect(isLatestSource(a, [a])).toBe(false);
  });
});
