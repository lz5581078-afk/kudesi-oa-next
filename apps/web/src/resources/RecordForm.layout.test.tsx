import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS, PRODUCT_LAYOUTS, productLayoutKey } from '@kudesi/shared';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../api/client',async original=>{const actual=await original<typeof import('../api/client')>();return {...actual,api:vi.fn((path:string,options?:unknown)=>path==='/finance/products/code-preview'?Promise.resolve({code:'HC-REAL-PREVIEW',basicInfoFullName:'合成预览',manual:false,notes:[]}):actual.api(path,options as Parameters<typeof actual.api>[1]))};});
const create = vi.fn();
const saveForm = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const list = vi.fn();
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return {
    ...mod,
    resourceApi: { ...mod.resourceApi, saveForm: (...a: unknown[]) => saveForm(...a), create: (...a: unknown[]) => create(...a), update: (...a: unknown[]) => update(...a), remove: (...a: unknown[]) => remove(...a), similarCheck: vi.fn().mockResolvedValue({ blocked: [], warnings: [] }), list: (...a: unknown[]) => list(...a), get: vi.fn().mockResolvedValue({ id: 1, title: '组件', data: { archiveType: 'raw' } }) },
    draftApi: { ...mod.draftApi, get: vi.fn().mockResolvedValue({ draft: null }), save: vi.fn(), remove: vi.fn() },
  };
});
import { RecordForm } from './RecordForm';

const def = FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
const saved = { id: 9, type: 'finance-products', title: '苹果', status: 'active', statusReason: null, data: {}, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' };

beforeEach(() => {
  create.mockReset().mockResolvedValue(saved);
  saveForm.mockReset().mockImplementation(async (type, body) => body.id ? update(type, body.id, body.values) : create(type, body.values, body.status));
  update.mockReset().mockResolvedValue(saved);
  remove.mockReset().mockResolvedValue({});
  list.mockReset().mockImplementation(async (type: string) => (type === 'finance-suppliers' ? { items: [{ id: 3, title: '供应商甲', status: 'active', data: {} }], total: 1 } : { items: [], total: 0 }));
});
afterEach(cleanup);

it('赠品入口保留对照站填写提示，编码简称输入转大写',()=>{
 render(<RecordForm def={def} record={null} initial={{archiveType:'raw'}} onClose={vi.fn()} onSaved={vi.fn()}/>);
 expect(screen.getByPlaceholderText('例如：购种合同、拌种剂10克')).toBeTruthy();
 const code=screen.getByPlaceholderText('例如：HT、BZJ10G，仅字母和数字') as HTMLInputElement;
 fireEvent.change(code,{target:{value:'bzj10g'}});
 expect(code.value).toBe('BZJ10G');
});

it('外购名称规格净重随规格单位换算，人工纠错重量不冒充商品净重',()=>{
 render(<RecordForm def={def} record={null} initial={{archiveType:'purchased',supplyMode:'original_purchase',specQty:1,specUnit:'KG',weightG:1700,weightManual:true}} onClose={vi.fn()} onSaved={vi.fn()}/>);
 expect(screen.getByRole('heading',{name:'新增外购成品 · 原装采购'})).toBeTruthy();
 expect(screen.getByText('商品净重：1 kg')).toBeTruthy();
 fireEvent.change(screen.getByRole('textbox',{name:/名称规格/}),{target:{value:'500'}});
 fireEvent.change(screen.getByRole('combobox',{name:/名称单位/}),{target:{value:'G'}});
 expect(screen.getByText('商品净重：0.5 kg')).toBeTruthy();
 expect((screen.getByLabelText('重量') as HTMLInputElement).value).toBe('1.7');
});

const TYPES: Array<[string, Record<string, unknown>]> = [
  ['raw', { archiveType: 'raw' }], ['self_made', { archiveType: 'self_made' }], ['purchased_original', { archiveType: 'purchased', supplyMode: 'original_purchase' }], ['purchased_oem', { archiveType: 'purchased', supplyMode: 'supplier_oem' }],
  ['package', { archiveType: 'package' }], ['oem_package', { archiveType: 'oem_package' }], ['shipping_material', { archiveType: 'shipping_material' }], ['custom', { archiveType: 'zz_custom' }],
];

describe('商品档案表单：每种档案类型的分区顺序来自同一份布局', () => {
  it.each(TYPES)('%s：分区标题按布局顺序出现', (key, initial) => {
    expect(productLayoutKey(initial)).toBe(key);
    render(<RecordForm def={def} record={null} initial={initial} onClose={() => undefined} onSaved={() => undefined} />);
    const sections = [...document.querySelectorAll('[data-sec]')].map(el => el.getAttribute('data-sec'));
    const expected = PRODUCT_LAYOUTS[key as keyof typeof PRODUCT_LAYOUTS].sections.filter(s=>!(key==='shipping_material'&&s.id==='extra')).filter(s => !(['package','oem_package'].includes(key) && s.id === 'category')).filter(s => !(key === 'custom' && ['cost','total','photos'].includes(s.id))).map(s => s.id);
    // 用户确认冲突以对照站为准，原料、外购成品和发货物料保留赠品入口。
    expect(sections).toEqual(expected);
    expect(document.querySelector('.rf-anchors')).toBeNull();
  });

  it('原料用旧版叫法“原料名称 / 规格 / 名称单位”，必填标星；自产成品的名称规格选填', () => {
    const { unmount } = render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw' }} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText('原料名称').parentElement?.textContent).toContain('必填');
    expect(screen.getByText('名称单位').parentElement?.textContent).toContain('必填');
    unmount();
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'self_made' }} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText('名称规格').parentElement?.textContent).not.toContain('必填');
    expect(screen.getByText('品牌').parentElement?.textContent).toContain('必填');
  });

  it('必填没填：点保存把每一项标出来，包括供货来源和重量，不发请求', async () => {
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'shipping_material' }} onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(()=>expect((screen.getByRole('textbox',{name:'系统自动编号'}) as HTMLInputElement).value).toBe('HC-REAL-PREVIEW'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('请选择最下级分类')).toBeTruthy();
    expect(screen.getByText(/请至少维护一条完整供货来源/)).toBeTruthy();
    expect(screen.getByText('请填写重量')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('编辑原料：主档、价格修改及来源删除在一次表单请求中提交', async () => {
    list.mockImplementation(async (type: string) => {
      if (type === 'finance-product-sources') return { items: [{ id: 41, status: 'active', data: { supplierId: 3, originArea: '山东', purchasePrice: 125000 } }, { id: 42, status: 'active', data: { supplierId: 3, originArea: '甘肃', purchasePrice: 100000 } }], total: 2 };
      if (type === 'finance-suppliers') return { items: [{ id: 3, title: '供应商甲', status: 'active', data: {} }], total: 1 };
      return { items: [], total: 0 };
    });
    update.mockResolvedValue({ ...saved, id: 7 });
    const record = { ...saved, id: 7, title: '番茄种子', data: { archiveType: 'raw', categoryId: 1, code:'YL-SYNTHETIC',giftShortName:'历史赠品简称',giftCodeShortName:'HISTGIFT',shape:'历史形态',name: '番茄种子', specQty: 500, specUnit: 'G', purchaseSpec: '斤', freight: 100, handlingFee: 50, weightG: 500 } };
    render(<RecordForm def={def} record={record} onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(screen.getAllByLabelText('产区')).toHaveLength(2));
    fireEvent.change(screen.getAllByLabelText('来源采购价')[0], { target: { value: '13' } });
    fireEvent.click(screen.getAllByRole('button', { name: '删除供货来源' })[1]);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认并保存' }));
    await waitFor(() => expect(saveForm).toHaveBeenCalled());
    expect(saveForm.mock.calls[0][1]).toMatchObject({ id: 7, collections: [{ type: 'finance-product-sources', expected: [{ id: 41 }, { id: 42 }], rows: [{ id: 41, values: { supplierId: 3, purchasePrice: 1300 } }] }] });
    expect(saveForm.mock.calls[0][1].values).toMatchObject({giftShortName:'历史赠品简称',giftCodeShortName:'HISTGIFT',shape:'历史形态'});
    expect(remove).not.toHaveBeenCalled();
    expect(update.mock.calls.some(c => c[0] === 'finance-product-sources')).toBe(false);
    // 档案本身不直接写采购价（由来源汇出）
    expect(update.mock.calls.find((c) => c[0] === 'finance-products')?.[2]).not.toHaveProperty('purchasePrice');
  });

  it('复制新增：带上被复制那条的供货来源（新行，不带行号）', async () => {
    list.mockImplementation(async (type: string) => (type === 'finance-product-sources'
      ? { items: [{ id: 41, status: 'active', data: { supplierId: 3, originArea: '山东', purchasePrice: 125000 } }], total: 1 }
      : type === 'finance-suppliers' ? { items: [{ id: 3, title: '供应商甲', status: 'active', data: {} }], total: 1 } : { items: [], total: 0 }));
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw', __copyOf: 7, name: '番茄种子' }} onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect((screen.getByLabelText('产区') as HTMLInputElement).value).toBe('山东'));
  });
});


it.each(TYPES.filter(([key])=>key!=='custom'))('%s新增/编辑/复制按对照站保留适用的赠品入口，不添加形态字段',(_key,initial)=>{
 for(const mode of ['create','edit','copy']){
  const data={...initial,categoryId:1,name:'合成历史档案',shape:'历史隐藏形态',giftShortName:'历史赠品简称',giftCodeShortName:'HISTGIFT'};
  const view=render(<RecordForm def={def} record={mode==='edit'?{...saved,data}:null} initial={mode==='edit'?undefined:{...data,...(mode==='copy'?{__copyOf:7}:{})}} onClose={vi.fn()} onSaved={vi.fn()}/>);
  const giftApplicable=['raw','purchased','shipping_material'].includes(String(initial.archiveType));
  for(const selector of ['[data-sec=gift]','[data-field=giftShortName]','[data-field=giftCodeShortName]'])expect(Boolean(document.querySelector(selector))).toBe(giftApplicable);
  if(giftApplicable){expect((screen.getByLabelText('赠品简称') as HTMLInputElement).value).toBe('历史赠品简称');expect((screen.getByLabelText('赠品编码简称') as HTMLInputElement).value).toBe('HISTGIFT');}
  expect(document.querySelector('[data-field=shape]')).toBeNull();
  if(initial.archiveType==='shipping_material'){expect(document.querySelector('[data-sec=extra]')).toBeNull();expect(document.querySelector('[data-field=brandId]')).toBeNull();}
  if(initial.archiveType==='raw'){expect(screen.getByText('分类由原料档案主页面决定；如需调整，请在列表中使用“移动分类”。')).toBeTruthy();expect(screen.queryByText(/原料可对应的成品名/)).toBeNull();expect(screen.getByRole('button',{name:'增加来源'})).toBeTruthy();}
  expect(def.fields.find(field=>field.key==='giftShortName')).toBeTruthy();expect(def.fields.find(field=>field.key==='shape')).toBeTruthy();view.unmount();
 }
});
