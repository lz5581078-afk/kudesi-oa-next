import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS, validateResourceInput } from '@kudesi/shared';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
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
  fireEvent.click(screen.getByRole('button', { name: '＋ 添加供货来源' }));
  fireEvent.click(screen.getByRole('button', { name: '选择供应商' }));
  fireEvent.click(await screen.findByRole('button', { name: /供应商甲 未设置简称/ }));
  fireEvent.change(screen.getByLabelText('产区'), { target: { value: '陕西' } });
  fireEvent.change(screen.getByLabelText('来源采购价'), { target: { value: '8' } });
};
const fillRaw = async (name: string) => { fill('原料名称', name); fill('系统规格', '千克'); fill('运费', '1'); fill('装卸费', '1'); await addSource(); };
const confirmQuality = async () => { fireEvent.click(await screen.findByRole('button', { name: '确认并保存' })); };

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
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
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
    fireEvent.click(screen.getByRole('button', { name: '保存并继续新增' })); await confirmQuality();
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
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
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
    fireEvent.click(screen.getByRole('button', { name: '保存并继续新增' }));
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
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
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
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(String(confirm.mock.calls[0][0])).toContain('名称完全相同');
    expect(create).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
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
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await confirmQuality();
    await screen.findByText('保存失败，请重试');
    expect(onSaved).not.toHaveBeenCalled();
    expect(draftRemove).not.toHaveBeenCalled();
    expect((screen.getByLabelText('产区') as HTMLInputElement).value).toBe('陕西');
    const key = saveForm.mock.calls[0][1].requestKey;
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await confirmQuality();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
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
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
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
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
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
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
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
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1); // 没填内容，直接关
    expect(ask).not.toHaveBeenCalled();
    fill('原料名称', '苹果');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1); // 选了“取消”，没关
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
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
