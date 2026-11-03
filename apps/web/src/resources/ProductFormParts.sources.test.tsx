import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('./RecordForm', () => ({ MoneyControl: () => null, RefSelect: () => null, clearRefCache: vi.fn() }));
vi.mock('../api/client', async orig => ({ ...await orig<typeof import('../api/client')>(), api: vi.fn().mockResolvedValue({ shipping_system_spec: [{ value: '套', label: '套' }, { value: '卷', label: '卷' }] }) }));
vi.mock('./api', () => ({ resourceApi: { list: vi.fn(), update: vi.fn(), create: vi.fn(), remove: vi.fn() } }));
import { resetUnitOptionsForTest } from './unitOptions';
import { resourceApi } from './api';
import { SourcesDraft, latestSource, loadSourceRows, sourceCollection, type SourceRow } from './ProductFormParts';
const row = (over: Partial<SourceRow>): SourceRow => ({ supplierId: 1, originArea: '测试', systemSpec: '斤', purchasePrice: 100, ...over });
afterEach(() => { cleanup(); vi.clearAllMocks(); resetUnitOptionsForTest({}); });
describe('供货来源的采购价时序', () => {
  it('最新预览按采购价时间，跳过停用来源；旧记录回退更新时间', () => {
    const a = row({ rowId: 1, priceUpdatedAt: '2020-01-01', updatedAt: '2026-01-01' });
    const b = row({ rowId: 2, updatedAt: '2021-01-01' });
    expect(latestSource([a, b, row({ stopped: true, priceUpdatedAt: '2027-01-01' })])).toBe(b);
  });
  it('一次保存多条报价时最后提交用户最近修改价格的行，不把行号当最新报价', async () => {
    const a = row({ priceUpdatedAt: '2022-01-01', purchasePrice: 300 });
    const b = row({ priceUpdatedAt: '2021-01-01', purchasePrice: 200 });
    const collection = sourceCollection([a, b], [], true);
    expect(collection.rows.map(row => row.values.purchasePrice)).toEqual([200, 300]);
    expect(collection.rows.every(row => !('priceUpdatedAt' in row.values))).toBe(true);

  });
  it('加载全部页，保留采购价时间、停用状态和供应商显示名', async () => {
    const item = (id: number) => ({ id, status: id === 2 ? 'inactive' : 'active', data: { supplierId: 4, purchasePrice: 100, priceUpdatedAt: '2020-01-01' }, refLabels: { supplierId: '测试供应商' }, updatedAt: '2026-01-01' });
    vi.mocked(resourceApi.list).mockResolvedValueOnce({ items: [item(1)], total: 2 } as never).mockResolvedValueOnce({ items: [item(2)], total: 2 } as never);
    expect(await loadSourceRows(7)).toMatchObject([{ rowId: 1, supplierLabel: '测试供应商', priceUpdatedAt: '2020-01-01', stopped: false }, { rowId: 2, stopped: true }]);
    expect(resourceApi.list).toHaveBeenLastCalledWith('finance-product-sources', expect.objectContaining({ page: 2, fieldValue: 7 }));
  });
});


describe('发货物料的来源系统规格', () => {
  it('管理窗也可回填已经使用但维护项已删除的规格，不虚构字典ID或新建记录', async () => {
    resetUnitOptionsForTest({ shipping_system_spec: [{ value: '历史张', label: '历史张' }] });
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0 } as never);
    const change = vi.fn();
    render(<SourcesDraft reference needSpec canCost rows={[row({ systemSpec: '' })]} onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: '管理单位与规格' }));
    const button = await screen.findByRole('button', { name: '历史张' });
    expect(screen.queryByRole('button', { name: '删除系统规格历史张' })).toBeNull();
    fireEvent.click(button);
    expect(change).toHaveBeenCalledWith([expect.objectContaining({ systemSpec: '历史张' })]);
    expect(screen.queryByRole('dialog', { name: '管理系统规格' })).toBeNull();
    expect(resourceApi.create).not.toHaveBeenCalled();
  });
  it('使用物料独立维护的下拉列表，保留历史值，不混入原料计价规格', () => {
    resetUnitOptionsForTest({ system_spec: [{ value: '斤', label: '斤' }], shipping_system_spec: [{ value: '卷', label: '卷' }] });
    const change = vi.fn();
    render(<SourcesDraft reference needSpec canCost rows={[row({ systemSpec: '历史计量' })]} onChange={change} />);
    const select = screen.getByRole('combobox', { name: '来源系统规格' });
    expect(select.textContent).toContain('历史计量');
    expect(select.textContent).toContain('卷');
    expect(select.textContent).not.toContain('斤');
    fireEvent.change(select, { target: { value: '卷' } });
    expect(change).toHaveBeenCalledWith([expect.objectContaining({ systemSpec: '卷' })]);
  });
  it('系统规格管理的Escape只关闭内层管理窗，保留外层新增表单', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0 } as never);
    const outerEscape = vi.fn();
    document.addEventListener('keydown', outerEscape);
    try {
      render(<div role="dialog" aria-label="新增物料"><SourcesDraft reference needSpec canCost rows={[row({})]} onChange={vi.fn()} /></div>);
      fireEvent.click(screen.getByRole('button', { name: '管理单位与规格' }));
      const inner = await screen.findByRole('dialog', { name: '管理系统规格' });
      fireEvent.keyDown(inner, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: '管理系统规格' })).toBeNull();
      expect(screen.getByRole('dialog', { name: '新增物料' })).toBeTruthy();
      expect(outerEscape).not.toHaveBeenCalled();
      expect(resourceApi.list).toHaveBeenCalledWith('finance-product-units', expect.objectContaining({ tab: 'shipping_system_spec' }));
    } finally { document.removeEventListener('keydown', outerEscape); }
  });
  it('管理窗选择已有名称后回填并关闭；新增后立即回填且窗口保持打开，不出现编码字段', async () => {
    const existing = { id: 20, title: '卷', status: 'active', data: { kind: 'shipping_system_spec', name: '卷' } };
    const created = { id: 21, title: '套', status: 'active', data: { kind: 'shipping_system_spec', name: '套' } };
    let added = false;
    vi.mocked(resourceApi.list).mockImplementation(async type => ({ items: type === 'finance-product-units' ? added ? [existing, created] : [existing] : [], total: type === 'finance-product-units' ? added ? 2 : 1 : 0 }) as never);
    vi.mocked(resourceApi.create).mockImplementation(async () => { added = true; return created as never; });
    const outerSubmit = vi.fn();
    function Form() { const [rows, setRows] = useState([row({ systemSpec: '' })]); return <form onSubmit={event => { event.preventDefault(); outerSubmit(); }}><SourcesDraft reference needSpec canCost rows={rows} onChange={setRows} /></form>; }
    render(<Form />);
    fireEvent.click(screen.getByRole('button', { name: '管理单位与规格' }));
    fireEvent.click(await screen.findByRole('button', { name: '卷' }));
    expect((screen.getByRole('combobox', { name: '来源系统规格' }) as HTMLSelectElement).value).toBe('卷');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '管理单位与规格' }));
    const dialog = await screen.findByRole('dialog', { name: '管理系统规格' });
    await within(dialog).findByRole('button', { name: '卷' });
    expect(screen.queryByText('编码设置')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/名称/), { target: { value: '套' } });
    fireEvent.click(screen.getByRole('button', { name: '新增系统规格' }));
    await screen.findByRole('button', { name: '套' });
    expect((screen.getByRole('combobox', { name: '来源系统规格' }) as HTMLSelectElement).value).toBe('套');
    expect(screen.getByRole('dialog', { name: '管理系统规格' })).toBe(dialog);
    expect(outerSubmit).not.toHaveBeenCalled();
  });

});


describe('删除最后一条来源', () => {
  it('清空为一条新空行，旧行ID不进入保存列表，其他表单数据仍由父表单保留', () => {
    const original = row({ rowId: 8, version: 'v8' });
    let changed: SourceRow[] = [];
    render(<SourcesDraft rows={[original]} onChange={rows => { changed = rows; }} canCost needSpec reference />);
    fireEvent.click(screen.getByRole('button', { name: '删除供货来源' }));
    expect(changed).toHaveLength(1);
    expect(changed[0].supplierId).toBeNull();
    expect(changed[0].rowId).toBeUndefined();
    expect(sourceCollection(changed, [original], true)).toMatchObject({ expected: [{ id: 8, version: 'v8' }], rows: [] });
  });
});
