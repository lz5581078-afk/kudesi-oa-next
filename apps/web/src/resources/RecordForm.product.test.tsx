import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS, validateResourceInput } from '@kudesi/shared';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../api/client',async original=>{const actual=await original<typeof import('../api/client')>();return {...actual,api:vi.fn((path:string,options?:unknown)=>path==='/finance/products/code-preview'?Promise.resolve({code:'HC-REAL-PREVIEW',basicInfoFullName:'合成预览名称',manual:false,notes:[]}):actual.api(path,options as Parameters<typeof actual.api>[1]))};});
const create = vi.fn();
const saveForm = vi.fn();
const similar = vi.fn();
const draftGet = vi.fn();
const draftSave = vi.fn();
const draftRemove = vi.fn();
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return {
    ...mod,
    resourceApi: { ...mod.resourceApi, saveForm: (...a: unknown[]) => saveForm(...a), create: (...a: unknown[]) => create(...a), similarCheck: (...a: unknown[]) => similar(...a), list: vi.fn(async (type: string) => (type === 'finance-suppliers' ? { items: [{ id: 3, title: '供应商甲', status: 'active', data: {} }], total: 1 } : type === 'finance-categories' ? { items: [{ id: 1, title: '原料分类', status: 'active', data: { archiveType: 'raw' } }], total: 1 } : { items: [], total: 0 })) },
    draftApi: { ...mod.draftApi, get: (...a: unknown[]) => draftGet(...a), save: (...a: unknown[]) => draftSave(...a), remove: (...a: unknown[]) => draftRemove(...a) },
  };
});
import {resourceApi,type ResourceDto} from './api';
import { RecordForm } from './RecordForm';
import { resetUnitOptionsForTest } from './unitOptions';

const def = FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
const saved = { id: 9, type: 'finance-products', title: '苹果', status: 'active', statusReason: null, data: {}, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' };
/** 必填的分类、规格数量、规格单位（客户端会先拦住没填的必填项） */
const REQ = { archiveType: 'raw', categoryId: 1, specQty: 1, specUnit: 'KG' };
const fill = (label: string, value: string) => fireEvent.change(screen.getAllByLabelText(new RegExp(`^${label}`))[0], { target: { value } });
/** 原料的必填核算资料都填上，核算资料确认没有未完成项 */
/** 原料至少要有一条完整的供货来源（供应商、产区、采购价） */
const addSource = async () => {
  fireEvent.click(screen.getByRole('button', { name: '增加来源' }));
  fireEvent.click(screen.getByRole('button', { name: '选择供应商' }));
  fireEvent.click(await screen.findByRole('button', { name: /供应商甲 未设置简称/ }));
  fireEvent.change(screen.getByLabelText('产区'), { target: { value: '陕西' } });
  fireEvent.change(screen.getByLabelText('来源采购价'), { target: { value: '8' } });
};
const fillRaw = async (name: string) => { fill('原料名称', name); fill('系统规格', '千克'); fill('运费', '1'); fill('装卸费', '1'); await addSource(); };
const clickSave=async(name='保存')=>{await waitFor(()=>expect((screen.getByRole('textbox',{name:/^(系统自动编号|产品包装编号|OEM包装编号)$/}) as HTMLInputElement).value).not.toBe(''),{timeout:3000});fireEvent.click(screen.getByRole('button',{name}));};
const confirmQuality = async () => { const dialog=await screen.findByRole('dialog',{name:'核算资料确认'});for(const button of within(dialog).queryAllByRole('button',{name:'确认不需要'})){const row=button.closest('.product-quality-row')!;fireEvent.change(within(row as HTMLElement).getByRole('combobox'),{target:{value:'合成无此组成'}});fireEvent.click(button);}expect(dialog.querySelector('.product-quality-errors')?.textContent??'').toBe('');fireEvent.click(await screen.findByRole('button', { name: '确认并保存' })); };

beforeEach(() => {
  resetUnitOptionsForTest({});
  create.mockReset().mockResolvedValue(saved);
  saveForm.mockReset().mockImplementation(async (type, body) => create(type, body.values, body.status));
  similar.mockReset().mockResolvedValue({ blocked: [], warnings: [] });
  draftGet.mockReset().mockResolvedValue({ draft: null });
  draftSave.mockReset().mockResolvedValue({});
  draftRemove.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('商品档案新建：草稿、继续新建、零值确认', () => {
  it.each([
    ['raw', '', 'system_spec'], ['self_made', '', 'self_made_system_spec'],
    ['purchased', 'original_purchase', 'purchased_system_spec'], ['purchased', 'supplier_oem', 'purchased_system_spec'],
    ['package', '', 'package_system_spec'], ['oem_package', '', 'oem_package_system_spec'],
  ])('%s %s的系统规格使用所属目录的下拉和管理弹窗，历史名称回填而不变成引用ID', async (archiveType, supplyMode, kind) => {
    resetUnitOptionsForTest({ system_spec: [{ value: '原料专用规格', label: '原料专用规格' }], [kind]: [{ value: '当前目录规格', label: '当前目录规格' }] });
    render(<RecordForm def={def} record={null} initial={{ archiveType, supplyMode, categoryId: 1, purchaseSpec: '已有历史规格' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    const field = document.querySelector<HTMLElement>('[data-field="purchaseSpec"]')!;
    const select = within(field).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('已有历史规格');
    expect(new Set([...select.options].map(option => option.value))).toEqual(new Set(['', '当前目录规格', '已有历史规格']));
    fireEvent.click(within(field).getByRole('button', { name: '管理单位与规格' }));
    const dialog = await screen.findByRole('dialog', { name: '管理系统规格' });
    await waitFor(() => expect(within(dialog).queryByText('读取中…')).toBeNull());
    expect(within(dialog).queryByText('编码设置')).toBeNull();
    expect(within(dialog).queryByText('原料专用规格')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '当前目录规格' }));
    expect(select.value).toBe('当前目录规格');
    expect(screen.queryByRole('dialog', { name: '管理系统规格' })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['package', 'oem_package'])('%s新建等公司选项返回后，用名称单位首项的名称作系统规格，尺寸首项及零库存初始化且不算修改', async archiveType => {
    resetUnitOptionsForTest({}, false);
    const close = vi.fn(), confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      render(<RecordForm def={def} record={null} initial={{ archiveType, categoryId: 1 }} onClose={close} onSaved={vi.fn()} />);
      const system = document.querySelector<HTMLSelectElement>('[data-field="purchaseSpec"] select')!;
      const dimension = document.querySelector<HTMLSelectElement>('[data-field="dimensionUnit"] select')!;
      expect(system.value).toBe(''); expect(dimension.value).toBe('');
      act(() => resetUnitOptionsForTest({ spec_unit: [{ value: 'KG', label: '千克' }], dimension_unit: [{ value: 'cm', label: '厘米' }], system_spec: [{ value: '其他规格', label: '其他规格' }] }));
      await waitFor(() => expect(system.value).toBe('千克'));
      expect(dimension.value).toBe('cm');
      expect((screen.getByLabelText('订单库存') as HTMLInputElement).value).toBe('0');
      expect((screen.getByLabelText('实际库存') as HTMLInputElement).value).toBe('0');
      expect((screen.getByLabelText('重量输入单位') as HTMLSelectElement).value).toBe('g');
      fireEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!);
      expect(confirm).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    } finally { confirm.mockRestore(); }
  });
  it('包装默认个/毫米，手工清空及恢复草稿的空值不被后续选项刷新覆盖', async () => {
    const view = render(<RecordForm def={def} record={null} initial={{ archiveType: 'package', categoryId: 1 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    const system = document.querySelector<HTMLSelectElement>('[data-field="purchaseSpec"] select')!;
    const dimension = document.querySelector<HTMLSelectElement>('[data-field="dimensionUnit"] select')!;
    await waitFor(() => expect(system.value).toBe('个')); expect(dimension.value).toBe('mm');
    fireEvent.change(system, { target: { value: '' } }); fireEvent.change(dimension, { target: { value: '' } });
    act(() => resetUnitOptionsForTest({ spec_unit: [{ value: 'KG', label: '千克' }], dimension_unit: [{ value: 'cm', label: '厘米' }] }));
    expect(system.value).toBe(''); expect(dimension.value).toBe('');
    view.unmount();
    draftGet.mockResolvedValue({ draft: { payload: { purchaseSpec: '', dimensionUnit: '', orderStock: '', actualStock: '' } } });
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'package', categoryId: 1 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByText(/已恢复上次保存/);
    expect(document.querySelector<HTMLSelectElement>('[data-field="purchaseSpec"] select')!.value).toBe('');
    expect(document.querySelector<HTMLSelectElement>('[data-field="dimensionUnit"] select')!.value).toBe('');
    expect((screen.getByLabelText('订单库存') as HTMLInputElement).value).toBe('');
  });
  it('包装编辑与复制不补系统规格及尺寸默认，复制重置的库存仍初始化零', () => {
    const data = { archiveType: 'package', categoryId: 1, purchaseSpec: '', dimensionUnit: '', weightG: 500 };
    render(<RecordForm def={def} record={{ ...saved, data }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(document.querySelector<HTMLSelectElement>('[data-field="purchaseSpec"] select')!.value).toBe('');
    expect(document.querySelector<HTMLSelectElement>('[data-field="dimensionUnit"] select')!.value).toBe('');
    expect((screen.getByLabelText('订单库存') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('重量输入单位') as HTMLSelectElement).value).toBe('kg');
    expect((screen.getByLabelText('重量') as HTMLInputElement).value).toBe('0.5');
    cleanup();
    render(<RecordForm def={def} record={null} initial={{ ...data, __copyOf: 7 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(document.querySelector<HTMLSelectElement>('[data-field="purchaseSpec"] select')!.value).toBe('');
    expect(document.querySelector<HTMLSelectElement>('[data-field="dimensionUnit"] select')!.value).toBe('');
    expect((screen.getByLabelText('订单库存') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('重量输入单位') as HTMLSelectElement).value).toBe('kg');
  });
  it('包装继续新增保留类别、尺寸单位、重量单位及系统规格，清空库存并恢复零', async () => {
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'package', categoryId: 1, name: '合成包装', brandId: 2, packagingCategory: 'bottle', capacities: '500G', specUnit: 'KG', weightG: 10, weightUnit: 'jin', dimensionUnit: 'cm', orderStock: 1.25, actualStock: 0.5, purchaseSpec: '个', purchasePrice: 100, freight: 1, handlingFee: 1 }} onClose={vi.fn()} onSaved={vi.fn()} onContinued={vi.fn()} />);
    await clickSave('保存并继续新增'); await confirmQuality();
    await screen.findByText(/可以继续新增/);
    expect(create.mock.calls[0][1]).toMatchObject({ orderStock: 1.25, actualStock: 0.5 });
    expect(document.querySelector<HTMLSelectElement>('[data-field="packagingCategory"] select')!.value).toBe('bottle');
    expect(document.querySelector<HTMLSelectElement>('[data-field="dimensionUnit"] select')!.value).toBe('cm');
    expect(document.querySelector<HTMLSelectElement>('[data-field="purchaseSpec"] select')!.value).toBe('个');
    expect((screen.getByLabelText('订单库存') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('实际库存') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('重量输入单位') as HTMLSelectElement).value).toBe('jin');
  });
  it('公司单位尚未返回时不抢选内置首项，返回后再选公司首项', async () => {
    resetUnitOptionsForTest({}, false);
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'shipping_material', categoryId: 1 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(document.querySelector<HTMLSelectElement>('[data-field="specUnit"] select')?.value).toBe('');
    act(() => resetUnitOptionsForTest({ shipping_unit: [{ value: 'ROLL', label: '卷' }] }));
    await waitFor(() => expect(document.querySelector<HTMLSelectElement>('[data-field="specUnit"] select')?.value).toBe('ROLL'));
  });
  it('发货物料默认公司首个名称单位，默认值本身不导致未保存确认', async () => {
    resetUnitOptionsForTest({ shipping_unit: [{ value: 'ROLL', label: '卷' }, { value: 'EA', label: '个' }] });
    const close = vi.fn(), confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      render(<RecordForm def={def} record={null} initial={{ archiveType: 'shipping_material', categoryId: 1 }} onClose={close} onSaved={vi.fn()} />);
      await waitFor(() => expect(document.querySelector<HTMLSelectElement>('[data-field="specUnit"] select')?.value).toBe('ROLL'));
      fireEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!);
      expect(confirm).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    } finally { confirm.mockRestore(); }
  });
  it('新增名称单位可手选和清空，后续选项刷新不覆盖；无维护列表按旧默认包', async () => {
    resetUnitOptionsForTest({ shipping_unit: [{ value: 'ROLL', label: '卷' }, { value: 'EA', label: '个' }] });
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'shipping_material', categoryId: 1 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    const select = document.querySelector<HTMLSelectElement>('[data-field="specUnit"] select')!;
    await waitFor(() => expect(select.value).toBe('ROLL'));
    fireEvent.change(select, { target: { value: 'EA' } });
    act(() => resetUnitOptionsForTest({ shipping_unit: [{ value: 'ROLL', label: '卷' }, { value: 'EA', label: '个' }, { value: 'CM', label: '厘米' }] }));
    expect(select.value).toBe('EA');
    fireEvent.change(select, { target: { value: '' } });
    act(() => resetUnitOptionsForTest({ shipping_unit: [{ value: 'EA', label: '个' }] }));
    expect(select.value).toBe('');
    cleanup(); resetUnitOptionsForTest({});
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw', categoryId: 1 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(document.querySelector<HTMLSelectElement>('[data-field="specUnit"] select')?.value).toBe('B'));
  });
  it('自产名称单位不默认，编辑和复制也不替已有空值重新选单位', async () => {
    resetUnitOptionsForTest({ spec_unit: [{ value: 'KG', label: '千克' }], shipping_unit: [{ value: 'EA', label: '个' }] });
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'self_made', categoryId: 1 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(document.querySelector<HTMLSelectElement>('[data-field="specUnit"] select')?.value).toBe('');
    cleanup();
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'shipping_material', categoryId: 1, specUnit: '', __copyOf: 9 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(document.querySelector<HTMLSelectElement>('[data-field="specUnit"] select')?.value).toBe('');
    cleanup();
    render(<RecordForm def={def} record={{ ...saved, data: { archiveType: 'shipping_material', categoryId: 1, specUnit: '' } }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(document.querySelector<HTMLSelectElement>('[data-field="specUnit"] select')?.value).toBe('');
  });
  it('复制新增沿用来源资料，不被普通新增保存的草稿覆盖', async () => {
    draftGet.mockResolvedValue({ draft: { payload: { name: '其他草稿', categoryId: 99 } } });
    render(<RecordForm def={def} record={null} initial={{...REQ,__copyOf:7,name:'被复制的原料'}} onClose={()=>undefined} onSaved={()=>undefined}/>);
    await waitFor(()=>expect((screen.getByLabelText(/^原料名称/) as HTMLInputElement).value).toBe('被复制的原料'));
    expect(draftGet).not.toHaveBeenCalled();
    expect(screen.queryByText(/已恢复上次保存/)).toBeNull();
  });
  it('保存草稿：把当前填的内容存到服务器并关闭；再打开自动恢复，可清除', async () => {
    const onClose = vi.fn();
    const { unmount } = render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw' }} onClose={onClose} onSaved={() => undefined} onContinued={() => undefined} />);
    fill('原料名称', '半成品苹果');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(draftSave).toHaveBeenCalledTimes(1);
    expect(draftSave.mock.calls[0][0]).toBe('resource%3Afinance-products:raw:_');
    expect((draftSave.mock.calls[0][1] as { payload: Record<string, unknown> }).payload.name).toBe('半成品苹果');
    unmount();
    draftGet.mockResolvedValue({ draft: { payload: { name: '半成品苹果' }, title: '', updatedAt: '' } });
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw' }} onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText(/已恢复上次保存的草稿/);
    expect((screen.getAllByLabelText(/^原料名称/)[0] as HTMLInputElement).value).toBe('半成品苹果');
    fireEvent.click(screen.getByRole('button', { name: '清除草稿' }));
    await waitFor(() => expect(draftRemove).toHaveBeenCalled());
    expect(screen.queryByText(/已恢复上次保存的草稿/)).toBeNull();
  });

  it('保存并继续新增：不关弹窗，只留档案类型，列表由 onContinued 刷新；成功后清掉草稿', async () => {
    const onSaved = vi.fn();
    const onContinued = vi.fn();
    render(<RecordForm def={def} record={null} initial={REQ} onClose={() => undefined} onSaved={onSaved} onContinued={onContinued} />);
    await fillRaw('苹果');
    await clickSave('保存并继续新增');
    await confirmQuality();
    await screen.findByText(/可以继续新增/);
    expect(onContinued).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(draftRemove).toHaveBeenCalled();
    expect((screen.getAllByLabelText(/^原料名称/)[0] as HTMLInputElement).value).toBe('');
  });

  it('保存草稿后重新打开，供货来源、采购价和人工编号仍在，正式保存不发送草稿内部字段', async () => {
    const view = render(<RecordForm def={def} record={null} initial={REQ} onClose={() => undefined} onSaved={() => undefined} />);
    await fillRaw('草稿原料');
    fireEvent.click(screen.getByRole('button', { name: '人工修正' }));
    fireEvent.change(screen.getByRole('textbox', { name: '系统自动编号' }), { target: { value: 'MANUAL-RAW' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(draftSave).toHaveBeenCalled());
    const payload = draftSave.mock.calls.at(-1)![1].payload;
    view.unmount();
    draftGet.mockResolvedValue({ draft: { payload } });
    render(<RecordForm def={def} record={null} initial={REQ} onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText('已恢复上次保存的草稿。');
    expect((screen.getByLabelText('产区') as HTMLInputElement).value).toBe('陕西');
    await waitFor(() => expect((screen.getByLabelText('来源采购价') as HTMLInputElement).value).toBe('8'));
    expect((screen.getByRole('textbox', { name: '系统自动编号' }) as HTMLInputElement).value).toBe('MANUAL-RAW');
    await clickSave('保存');
    await confirmQuality();
    await waitFor(() => expect(saveForm).toHaveBeenCalled());
    expect(saveForm.mock.calls[0][1].collections[0].rows[0].values).toMatchObject({ supplierId: 3, originArea: '陕西', purchasePrice: 800 });
    expect(saveForm.mock.calls[0][1].values.archiveType).toBe('raw');
    expect(validateResourceInput(def, saveForm.mock.calls[0][1].values, { status: def.defaultStatus }).errors).toEqual([]);
    expect(create.mock.calls.find(c => c[0] === 'finance-products')![1]).not.toHaveProperty('__productParts');
  });

  it('相似商品要确认才保存；选“取消”就不保存', async () => {
    similar.mockResolvedValue({ blocked: [], warnings: [{ text: '“苹果”：名称完全相同' }] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<RecordForm def={def} record={null} initial={REQ} onClose={() => undefined} onSaved={() => undefined} />);
    await fillRaw('苹果');
    await clickSave('保存');
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(String(confirm.mock.calls[0][0])).toContain('名称完全相同');
    expect(create).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await clickSave('保存');
    await confirmQuality();
    await waitFor(() => expect(create.mock.calls.filter((c) => c[0] === 'finance-products')).toHaveLength(1));
    expect(saveForm.mock.calls[0][1].collections[0].rows[0].values).toMatchObject({ supplierId: 3, originArea: '陕西' });
    confirm.mockRestore();
  });

  it('整组保存失败保留表单和来源，重试沿用请求标识；成功前不清草稿也不关闭', async () => {
    const onSaved = vi.fn();
    saveForm.mockRejectedValueOnce(new Error('模拟响应中断'));
    render(<RecordForm def={def} record={null} initial={REQ} onClose={() => undefined} onSaved={onSaved} />);
    await fillRaw('原子重试原料');
    await clickSave('保存');
    await confirmQuality();
    const dialog=await screen.findByRole('dialog',{name:'核算资料确认'});
    await within(dialog).findByText('保存失败：保存失败，请重试');
    expect(dialog.isConnected).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    expect(draftRemove).not.toHaveBeenCalled();
    expect((screen.getByLabelText('产区') as HTMLInputElement).value).toBe('陕西');
    const key = saveForm.mock.calls[0][1].requestKey;
    await confirmQuality();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog',{name:'核算资料确认'})).toBeNull();
    expect(saveForm.mock.calls[1][1].requestKey).toBe(key);
    expect(saveForm.mock.calls[1][1].collections[0].rows).toHaveLength(1);
  });

  it('运费、装卸费填 0 没写原因：先弹核算资料确认，原因写进零值说明再保存', async () => {
    const onSaved = vi.fn();
    render(<RecordForm def={def} record={null} initial={REQ} onClose={() => undefined} onSaved={onSaved} />);
    fill('原料名称', '苹果');
    fill('系统规格', '千克');
    fill('运费', '0');
    fill('装卸费', '1');
    await addSource();
    await clickSave('保存');
    const dialog = await screen.findByRole('dialog', { name: '核算资料确认' });
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('运费零值原因'), { target: { value: '产地自提' } });
    fireEvent.click(screen.getByRole('button', { name: '确认该项为0' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并保存' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect((create.mock.calls[0][1] as Record<string, unknown>).zeroValueReason).toContain('运费：产地自提');
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
  it.each(['original_purchase', 'supplier_oem'])('采购新增实际请求带隐藏类型和采购方式：%s', async supplyMode => {
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'purchased', supplyMode, categoryId: 1, name: '合成采购', brandId: 2, specQty: '1', specUnit: 'KG', purchaseSpec: '袋', purchasePrice: 100, freight: 1, handlingFee: 1, weightG: 1000, zeroValueReason: '包装组成：合成无包装\n人力组成：合成无人工' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await clickSave('保存');
    await confirmQuality();
    await waitFor(() => expect(saveForm).toHaveBeenCalled());
    const values = saveForm.mock.calls[0][1].values;
    expect(values).toMatchObject({ archiveType: 'purchased', supplyMode, categoryId: 1 });
    expect(validateResourceInput(def, values, { status: def.defaultStatus }).errors).toEqual([]);
  });

  it('包装不显示新增分类/供应商控件，但提交保留分类和已有隐藏供应商值', async () => {
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'package', categoryId: 1, supplierId: 3, name: '合成包装', brandId: 2, packagingCategory: 'bag', capacities: '500G', weightG: 10, purchaseSpec: '个', purchasePrice: 100, freight: 1, handlingFee: 1 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('region', { name: '所属分类' })).toBeNull();
    expect(screen.queryByText('供应商', { exact: true })).toBeNull();
    await clickSave('保存');
    await confirmQuality();
    await waitFor(() => expect(saveForm).toHaveBeenCalled());
    expect(saveForm.mock.calls[0][1].values).toMatchObject({ archiveType: 'package', categoryId: 1, supplierId: 3 });
    expect(validateResourceInput(def, saveForm.mock.calls[0][1].values, { status: def.defaultStatus }).errors).toEqual([]);
  });

});

describe('新建关闭确认', () => {
  it('填了内容点“取消”先确认；没填直接关；确认取消则留在表单', () => {
    const onClose = vi.fn();
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw' }} onClose={onClose} onSaved={() => undefined} />);
    fireEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!);
    expect(onClose).toHaveBeenCalledTimes(1); // 没填内容，直接关
    expect(ask).not.toHaveBeenCalled();
    fill('原料名称', '苹果');
    fireEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!);
    expect(onClose).toHaveBeenCalledTimes(1); // 选了“取消”，没关
    fireEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!);
    expect(onClose).toHaveBeenCalledTimes(2);
    ask.mockRestore();
  });
});

describe('人力成本版本：手动存草稿', () => {
  it('填写不自动保存，点保存草稿后关闭，再打开自动恢复', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const laborDef = (await import('@kudesi/shared')).getResourceDef('finance-labor-versions')!;
    const close = vi.fn();
    const first = render(<RecordForm def={laborDef} record={null} onClose={close} onSaved={() => undefined} />);
    fireEvent.change(screen.getAllByLabelText(/^版本编号/)[0], { target: { value: 'V9' } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(draftSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(draftSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect((draftSave.mock.calls[0][1] as { payload: Record<string, unknown> }).payload.versionCode).toBe('V9');
    first.unmount();
    draftGet.mockResolvedValue({ draft: { payload: { versionCode: 'V9' }, title: '', updatedAt: '' } });
    render(<RecordForm def={laborDef} record={null} onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText(/已恢复上次保存的草稿/);
    vi.useRealTimers();
  });

});

it('真实系统规格自动重量开启人工修正时保留已知草稿值，取消立即恢复自动且未知不补0',async()=>{render(<RecordForm def={def} record={null} initial={{archiveType:'raw',categoryId:1,purchaseSpec:'千克'}} onClose={()=>{}} onSaved={()=>{}}/>);const weight=screen.getByLabelText('重量') as HTMLInputElement;expect(weight.value).toBe('1');expect(weight.readOnly).toBe(true);fireEvent.click(screen.getByRole('button',{name:'人工修正重量'}));expect(weight.value).toBe('1');expect(weight.readOnly).toBe(false);fireEvent.change(weight,{target:{value:'7.5'}});fireEvent.click(screen.getByRole('button',{name:'恢复自动重量'}));expect(weight.value).toBe('1');cleanup();render(<RecordForm def={def} record={null} initial={{archiveType:'raw',categoryId:1,purchaseSpec:'袋'}} onClose={()=>{}} onSaved={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'人工修正重量'}));expect((screen.getByLabelText('重量') as HTMLInputElement).value).toBe('');});

it.each([
 ['raw',''],['self_made',''],['purchased','original_purchase'],['purchased','supplier_oem'],['package',''],['oem_package',''],['shipping_material',''],
])('真实%s/%s档案入口保留主页分类context与新建照片限制',async(archiveType,supplyMode)=>{
 render(<RecordForm def={def} record={null} initial={{archiveType,supplyMode,categoryId:1,unitDictionaryKind:archiveType==='shipping_material'?'shipping_unit':'archive_unit'}} onClose={vi.fn()} onSaved={vi.fn()}/>);
 if(!['package','oem_package'].includes(archiveType))await screen.findByText(/分类由.*档案主页面决定/);
 expect(document.querySelector('.reference-category-context [data-field="categoryId"]')).toBeNull();
 expect(screen.getByText('先保存这条商品档案，再添加图片。')).toBeTruthy();
 expect(document.querySelector('[data-field="photos"] input[type=file]')).toBeNull();
 expect((document.querySelector('[data-sec=code] input') as HTMLInputElement).disabled).toBe(true);
 if(['self_made','purchased','oem_package'].includes(archiveType))expect(document.querySelector('[data-field="brandId"] input[role=combobox]')).toBeTruthy();
 if(archiveType==='self_made'){
  const price=screen.getByLabelText('总采购价') as HTMLInputElement;expect(price.readOnly).toBe(true);expect(price.value).toBe('0');
  expect(screen.getByText('上次总采购价')).toBeTruthy();expect(screen.getByText('3个月平均总采购价')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'历史采购价'}));expect(await screen.findByText('暂无历史采购价。')).toBeTruthy();
  const select=document.querySelector('[data-field="productPackagingUnit"] select') as HTMLSelectElement;
  expect([...select.options].map(option=>option.value)).toEqual(['','B','J','D','PCS','G','KG']);
 }
});
it('真实复制入口把parent版本和原文件人工行版本带到统一saveForm，不携客户端人工金额',async()=>{
 const make=(id:number,type:string,data:Record<string,unknown>):ResourceDto=>({id,type,data,title:'合成'+id,status:'active',statusReason:null,version:'v'+id,createdAt:'',updatedAt:'',refLabels:{},files:{},secretConfigured:{}}),boms=[make(11,'finance-product-boms',{productId:7,componentId:5,qty:1}),make(12,'finance-product-boms',{productId:7,importLineKind:'labor',importLaborName:'存量人工',importLaborCost:120.25,qty:1})];
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-product-boms'?boms:[],total:type==='finance-product-boms'?2:0,page:1,pageSize:200}));const get=vi.spyOn(resourceApi,'get').mockResolvedValue(make(5,'finance-products',{archiveType:'raw',purchasePrice:20,freight:1,handlingFee:1,totalCost:22,weightG:10,specUnit:'B',purchaseSpec:'包'}));
 try{render(<RecordForm def={def} record={null} initial={{__copyOf:7,__copyVersion:'actual-parent-version',archiveType:'self_made',unitDictionaryKind:'archive_unit',categoryId:1,name:'真实复制合成品',brandId:5,specQty:1,specUnit:'KG',productPackagingSpec:'1',productPackagingUnit:'B',purchaseSpec:'千克',freight:1,handlingFee:1,weightG:10}} onClose={vi.fn()} onSaved={vi.fn()}/>);await screen.findByDisplayValue('存量人工');await clickSave();await confirmQuality();await waitFor(()=>expect(saveForm).toHaveBeenCalled());const body=saveForm.mock.calls[0][1];expect(body.copySource).toEqual({id:7,version:'actual-parent-version',files:{}});const rows=body.collections.find((collection:{type:string})=>collection.type==='finance-product-boms').rows;expect(rows[1]).toEqual({values:{qty:1,__sourceImportedLaborCopy:{rowId:12,version:'v12'}}});expect(JSON.stringify(rows)).not.toContain('importLaborCost');}finally{get.mockRestore();}
});
it('真实复制读取明细失败不能以空集合继续保存，保留已填资料',async()=>{
 vi.mocked(resourceApi.list).mockImplementation(async type=>{if(type==='finance-product-boms')throw new Error('合成目录中断');return {items:[],total:0,page:1,pageSize:200};});
 render(<RecordForm def={def} record={null} initial={{__copyOf:7,__copyVersion:'source-version',archiveType:'self_made',categoryId:1,name:'不得丢明细'}} onClose={vi.fn()} onSaved={vi.fn()}/>);
 await screen.findByText('组成资料未读取完整，请关闭后重新打开。');await clickSave();expect(await screen.findByText('来源或组成资料未读取完整，请关闭后重新打开，避免遗漏原明细。')).toBeTruthy();expect(saveForm).not.toHaveBeenCalled();expect(screen.queryByRole('dialog',{name:'核算资料确认'})).toBeNull();expect((screen.getByLabelText(/^自产成品名称/) as HTMLInputElement).value).toBe('不得丢明细');
});
it('真实原料表单按物流字段八位精度输入并在核算确认后原样提交',async()=>{
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-suppliers'?[{...saved,id:3,title:'供应商甲'}]:[],total:type==='finance-suppliers'?1:0,page:1,pageSize:200}));
 render(<RecordForm def={def} record={null} initial={{...REQ,name:'八位物流原料'}} onClose={vi.fn()} onSaved={vi.fn()}/>);
 await fillRaw('八位物流原料');fireEvent.change(screen.getByLabelText('来源采购价'),{target:{value:'1'}});fill('运费','0.12345678');fill('装卸费','0.12345678');
 expect(screen.getByText('¥1.24691356')).toBeTruthy();await clickSave();await confirmQuality();await waitFor(()=>expect(saveForm).toHaveBeenCalled());expect(saveForm.mock.calls[0][1].values).toMatchObject({freight:12.345678,handlingFee:12.345678});expect(saveForm.mock.calls[0][1].values.purchasePrice).toBeUndefined();expect(saveForm.mock.calls[0][1].collections[0].rows[0].values.purchasePrice).toBe(100);
});
it('旧原装采购缺人工标识时保留已有称重，明确false仍自动，OEM缺标识不猜人工',async()=>{
 const data={code:'WG-HISTORIC',archiveType:'purchased',supplyMode:'original_purchase',categoryId:1,name:'历史称重原装',brandId:2,specQty:1,specUnit:'KG',purchaseSpec:'千克',purchasePrice:100,freight:1,handlingFee:1,weightG:123,zeroValueReason:'包装组成：合成无包装\n人力组成：合成无人工'};
 const view=render(<RecordForm def={def} record={{...saved,data}} onClose={vi.fn()} onSaved={vi.fn()}/>);expect(screen.getByLabelText('重量')).toHaveProperty('value','0.123');expect(screen.getByLabelText('重量')).toHaveProperty('readOnly',false);await clickSave('保存修改');await confirmQuality();await waitFor(()=>expect(saveForm).toHaveBeenCalled());expect(saveForm.mock.calls[0][1].values).toMatchObject({weightManual:true,weightG:123});view.unmount();
 const auto=render(<RecordForm def={def} record={{...saved,data:{...data,weightManual:false}}} onClose={vi.fn()} onSaved={vi.fn()}/>);expect(screen.getByLabelText('重量')).toHaveProperty('value','1');expect(screen.getByLabelText('重量')).toHaveProperty('readOnly',true);auto.unmount();
 render(<RecordForm def={def} record={{...saved,data:{...data,supplyMode:'supplier_oem'}}} onClose={vi.fn()} onSaved={vi.fn()}/>);expect(screen.getByLabelText('重量')).toHaveProperty('readOnly',true);
});
it('自产编辑先显示五项汇总，再系统规格与重量公式，采购公式与本档总成本分层',async()=>{
 const make=(id:number,type:string,data:Record<string,unknown>):ResourceDto=>({...saved,id,type,data,version:'actual-'+id}),boms=[make(11,'finance-product-boms',{componentId:5,qty:0.5}),make(12,'finance-product-boms',{componentId:6,qty:2.5}),make(13,'finance-product-boms',{importLineKind:'labor',importLaborName:'存量人工',importLaborCost:120.25,qty:1.5})];
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-product-boms'?boms:[],total:type==='finance-product-boms'?3:0,page:1,pageSize:200}));const get=vi.spyOn(resourceApi,'get').mockImplementation(async(_type,id)=>make(id,'finance-products',id===5?{archiveType:'raw',purchasePrice:350,freight:20,handlingFee:10,totalCost:380,weightG:1000,specUnit:'KG'}:{archiveType:'oem_package',purchasePrice:8,freight:0,handlingFee:0,totalCost:8,weightG:10,specUnit:'B'}));
 try{render(<RecordForm def={def} record={make(7,'finance-products',{archiveType:'self_made',categoryId:1,name:'合成自产',brandId:2,specQty:1,specUnit:'KG',productPackagingSpec:'1',productPackagingUnit:'B',purchaseSpec:'千克',freight:47,handlingFee:13,totalCost:450.375,weightG:525})} onClose={vi.fn()} onSaved={vi.fn()}/>);await screen.findByDisplayValue('存量人工');await waitFor(()=>expect(screen.getByLabelText('重量')).toHaveProperty('value','0.525'));
 const result=document.querySelector('[data-sec=result]')!,overview=screen.getByLabelText('自产成品成本与重量实时汇总'),spec=result.querySelector('[data-field=purchaseSpec]')!;expect(overview.compareDocumentPosition(spec)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(within(screen.getByLabelText('自产成品重量组成')).getByText('0.525 kg')).toBeTruthy();expect(within(screen.getByLabelText('自产成品总采购价计算公式')).getByText('¥3.90375')).toBeTruthy();expect(screen.getByLabelText('总成本预览').textContent).toContain('¥4.50375');expect(screen.getByText('字段布局与新增自产成品保持一致，保存后更新当前记录。')).toBeTruthy();expect(screen.getByRole('button',{name:'取消'})).toBeTruthy();expect(screen.getByRole('button',{name:'选择图片'})).toBeTruthy();expect(screen.getByRole('button',{name:'手机扫码'})).toBeTruthy();expect(document.querySelector('[data-sec=code] button')?.textContent).toBe('人工修正');expect(screen.getByRole('button',{name:'恢复自动编号'}).closest('details')).toBeTruthy();
 }finally{get.mockRestore();}
});

it('逐来源核算：空价格确认0写入实际子表，UUID绑定随真实排序且失败重试保留确认',async()=>{
 saveForm.mockRejectedValueOnce(new Error('合成最后一步失败')).mockRejectedValueOnce(new Error('合成再次失败')).mockResolvedValue(saved);
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-suppliers'?[{...saved,id:3,title:'供应商甲'}]:type==='finance-categories'?[{...saved,id:1,title:'合成原料类',data:{archiveType:'raw'}}]:[],total:['finance-suppliers','finance-categories'].includes(type)?1:0,page:1,pageSize:200}));
 const view=render(<RecordForm def={def} record={null} initial={{...REQ,name:'逐来源确认',purchaseSpec:'千克',freight:1,handlingFee:1}} onClose={vi.fn()} onSaved={vi.fn()}/>);
 await addSource();fireEvent.change(screen.getByLabelText('来源采购价'),{target:{value:''}});
 fireEvent.click(screen.getByRole('button',{name:'增加来源'}));
 fireEvent.click(screen.getAllByRole('button',{name:'选择供应商'})[1]);fireEvent.click(await screen.findByRole('button',{name:/供应商甲 未设置简称/}));
 fireEvent.change(screen.getAllByLabelText('产区')[1],{target:{value:'乙产区'}});fireEvent.change(screen.getAllByLabelText('来源采购价')[1],{target:{value:'0'}});
 await clickSave();const dialog=await screen.findByRole('dialog',{name:'核算资料确认'});
 for(const [index,reason]of ['陕西来源确认为零','乙来源确认为零'].entries()){const input=within(dialog).getByRole('combobox',{name:`来源${index+1}采购价零值原因`});fireEvent.change(input,{target:{value:reason}});fireEvent.click(within(input.closest('.product-quality-row') as HTMLElement).getByRole('button',{name:'确认该项为0'}));}
 await confirmQuality();await waitFor(()=>expect(saveForm).toHaveBeenCalled());
 await within(dialog).findByText('保存失败：保存失败，请重试');
 expect(dialog.isConnected).toBe(true);expect(within(dialog).getByText('已确认：陕西来源确认为零')).toBeTruthy();expect(within(dialog).getByText('已确认：乙来源确认为零')).toBeTruthy();
 const first=structuredClone(saveForm.mock.calls[0][1]);
 await confirmQuality();await waitFor(()=>expect(saveForm).toHaveBeenCalledTimes(2));
 await within(dialog).findByText('保存失败：保存失败，请重试');expect(dialog.isConnected).toBe(true);expect(saveForm.mock.calls[1][1]).toEqual(first);
 fireEvent.click(within(dialog).getAllByRole('button',{name:'返回修改'}).at(-1)!);
 fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(draftSave).toHaveBeenCalled());
 const payload=draftSave.mock.calls[0][1].payload;
 expect(payload.__productParts.qualityConfirmations).toEqual(first.values.__sourceQuality.confirmations);
 expect(payload.__productParts.sources.map((row:{qualityKey:string})=>row.qualityKey).sort()).toEqual(first.values.__sourceQuality.rows.map((row:{key:string})=>row.key).sort());
 view.unmount();draftGet.mockResolvedValue({draft:{payload}});
 render(<RecordForm def={def} record={null} initial={{...REQ,name:'逐来源确认',purchaseSpec:'千克',freight:1,handlingFee:1}} onClose={vi.fn()} onSaved={vi.fn()}/>);
 await screen.findByText('已恢复上次保存的草稿。');
 await clickSave();const retryDialog=await screen.findByRole('dialog',{name:'核算资料确认'});
 expect(within(retryDialog).queryByRole('combobox',{name:'来源1采购价零值原因'})).toBeNull();
 fireEvent.click(within(retryDialog).getAllByRole('button',{name:'返回修改'}).at(-1)!);
 fireEvent.change(screen.getAllByLabelText('产区')[0],{target:{value:'变化产区'}});await clickSave();
 const changed=await screen.findByRole('dialog',{name:'核算资料确认'});
 expect(within(changed).getByRole('combobox',{name:'来源1采购价零值原因'})).toBeTruthy();
 fireEvent.click(within(changed).getAllByRole('button',{name:'返回修改'}).at(-1)!);
 fireEvent.change(screen.getAllByLabelText('产区')[0],{target:{value:'陕西'}});await clickSave();
 await confirmQuality();await waitFor(()=>expect(saveForm).toHaveBeenCalledTimes(3));
 expect(saveForm.mock.calls[2][1].values).toEqual(first.values);
 expect(saveForm.mock.calls[2][1].collections).toEqual(first.collections);
 const body=saveForm.mock.calls[2][1],collection=body.collections.find((row:{type:string})=>row.type==='finance-product-sources');
 expect(collection.rows.map((row:{values:{purchasePrice:number}})=>row.values.purchasePrice)).toEqual([0,0]);
 expect(Object.keys(body.values).some(key=>key.startsWith('source:')||key.startsWith('composition:'))).toBe(false);
 expect(body.values.zeroValueReason??'').not.toContain('来源');
 expect(body.values.__sourceQuality.rows.map((row:{index:number})=>row.index)).toEqual([0,1]);
 const confirmations=body.values.__sourceQuality.confirmations as Record<string,{reason:string;context:string}>;
 expect(Object.values(confirmations).map(receipt=>receipt.reason).sort()).toEqual(['乙来源确认为零','陕西来源确认为零'].sort());
 for(const binding of body.values.__sourceQuality.rows){expect(binding.key).toMatch(/^[0-9a-f-]{36}$/i);expect(confirmations[`source:${binding.key}:purchasePrice`]).toBeTruthy();}
});
