import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceCompositionPicker } from './FinanceCompositionPicker';
import { BomDraft, blankBomRow } from './BomDraft';
import { resourceApi, type ResourceDto } from './api';

vi.mock('./api', () => ({ resourceApi: { list: vi.fn(), get: vi.fn() } }));
const compositionAuth = vi.hoisted(() => ({ companyId: 1 }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { companyId: compositionAuth.companyId }, can: () => true }) }));
const record = (id: number, title: string, data: Record<string, unknown>, status = 'active'): ResourceDto => ({ id, title, data, type: '', status, statusReason: null, refLabels: {}, files: {}, secretConfigured: {}, createdAt: '', updatedAt: '' });
const list = (items: ResourceDto[], total = items.length) => ({ items, total, page: 1, pageSize: 200 });
beforeEach(() => { vi.clearAllMocks(); compositionAuth.companyId = 1; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T08:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('生产组成的直接搜索与分类选择', () => {
  it('读取超过200条的本类档案；名称拼音首字母可找到人工编号的末页资料，Enter选用', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => record(index + 1, index === 200 ? '番茄种子' : `合成原料${index}`, { name: index === 200 ? '番茄种子' : `合成原料${index}`, code: `MANUAL${index}`, archiveType: 'raw', categoryId: 10, purchaseSpec: '斤', purchasePrice: 12345 }));
    vi.mocked(resourceApi.list).mockImplementation(async (type, query) => {
      expect(query.tab).toBe('raw');
      return type === 'finance-products' ? list(rows.slice(((query.page ?? 1) - 1) * 200, (query.page ?? 1) * 200), rows.length) : list([record(10, '合成原料类', { archiveType: 'raw' })]);
    });
    const choose = vi.fn();
    render(<FinanceCompositionPicker group="raw" value={null} onChange={choose}/>);
    const input = screen.getByRole('combobox', { name: '搜索原料' });
    fireEvent.focus(input); fireEvent.change(input, { target: { value: 'fqzz' } });
    const option = await screen.findByRole('option', { name: /番茄种子/ });
    expect(option.textContent).toContain('斤');
    expect(option.textContent).not.toContain('123.45'); // 直接搜索的商品右侧为系统规格，分类窗才显示采购价
    expect(resourceApi.list).toHaveBeenCalledWith('finance-products', expect.objectContaining({ page: 2, pageSize: 200 }));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(choose).toHaveBeenCalledWith(201);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('分类窗根目录不混列资料，进入分类只看直属；跨分类搜索可选下级资料，Escape只关闭内窗', async () => {
    const categories = [record(10, '包装根目录', { archiveType: 'package' }), record(11, '下级目录', { archiveType: 'package', parentId: 10 })];
    const items = [record(31, '直属包装', { archiveType: 'package', categoryId: 10 }), record(32, '下级包装', { archiveType: 'package', categoryId: 11 })];
    vi.mocked(resourceApi.list).mockImplementation(async type => list(type === 'finance-products' ? items : categories));
    const choose = vi.fn(), parentEscape = vi.fn();
    const wrapper = render(<div onKeyDown={parentEscape}><FinanceCompositionPicker group="package" value={null} onChange={choose}/></div>);
    fireEvent.click(screen.getByRole('button', { name: '按分类选择' }));
    const dialog = await screen.findByRole('dialog', { name: '按分类选择产品包装' });
    fireEvent.click(await within(dialog).findByRole('button', { name: /包装根目录/ }));
    expect(within(dialog).getByRole('button', { name: /直属包装/ })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /下级包装/ })).toBeNull();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '搜索产品包装资料' }), { target: { value: '下级包装' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /下级包装/ }));
    expect(choose).toHaveBeenCalledWith(32);
    fireEvent.click(screen.getByRole('button', { name: '按分类选择' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(parentEscape).not.toHaveBeenCalled();
    expect(wrapper.container.firstChild).toBeTruthy();
  });

  it('人工只读取按日期有效且优先默认的当前版本；无成本权限的选项不显示金额', async () => {
    const versions = [record(1, '过期默认', { isDefault: true, effectiveTo: '2026-01-01' }), record(2, '当前默认', { isDefault: true, versionCode: 'CURRENT', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }), record(3, '未来默认', { isDefault: true, effectiveFrom: '2027-01-01' }), record(4, '更近非默认', { isDefault: false, effectiveFrom: '2026-10-01' }), record(5, '未启用', { isDefault: true }, 'draft')];
    vi.mocked(resourceApi.list).mockImplementation(async (type, query) => {
      if (type === 'finance-labor-versions') return list(versions);
      expect(query).toMatchObject({ fieldKey: 'versionId', fieldValue: 2 });
      return list(type === 'finance-labor-costs' ? [record(201, '人工行', { versionId: 2, workName: '合成打包', workCode: 'MANUAL', archiveCategoryId: 21, unitPrice: 12345 }), record(401, '其他版本行', { versionId: 4, workName: '不得列入' })] : [record(21, '当前人工类', { versionId: 2 })]);
    });
    const choose = vi.fn();
    const { rerender } = render(<FinanceCompositionPicker group="labor" value={null} onChange={choose} canCost={false}/>);
    fireEvent.focus(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: /合成打包/ });
    expect(option.textContent).not.toContain('123.45');
    expect(screen.queryByRole('option', { name: /不得列入/ })).toBeNull();
    fireEvent.click(option); expect(choose).toHaveBeenCalledWith(201);
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('合成打包 · MANUAL');
    rerender(<FinanceCompositionPicker group="labor" value={null} onChange={choose} canCost/>);
    fireEvent.focus(screen.getByRole('combobox'));
    expect((await screen.findByRole('option', { name: /合成打包/ })).textContent).toContain('¥123.450');
  });

  it('没有当前有效人工版本时不读取其他版本项目', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue(list([record(1, '未来版本', { effectiveFrom: '2027-01-01' })]));
    render(<FinanceCompositionPicker group="labor" value={null} onChange={vi.fn()}/>);
    fireEvent.focus(screen.getByRole('combobox'));
    expect(await screen.findByText('当前没有有效启用的人力成本版本')).toBeTruthy();
    expect(resourceApi.list).not.toHaveBeenCalledWith('finance-labor-costs', expect.anything());
  });

  it('历史引用不在当前可选目录时保留显示和值，浏览后关闭不会清除原引用', async () => {
    vi.mocked(resourceApi.list).mockImplementation(async type => list(type === 'finance-products' ? [record(1, '当前包装', { archiveType: 'package' })] : []));
    const choose = vi.fn();
    render(<FinanceCompositionPicker group="package" value={99} labelNow="已保存的历史包装" onChange={choose}/>);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.value).toBe('已保存的历史包装');
    fireEvent.focus(input);
    await screen.findByRole('option', { name: /当前包装/ });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('已保存的历史包装');
    expect(choose).not.toHaveBeenCalled();
    expect(resourceApi.get).not.toHaveBeenCalled();
  });

  it('切换档案类型后旧读取结果不混入新选项；读取失败可以原窗重试', async () => {
    let finishRaw!: (result: ReturnType<typeof list>) => void;
    let failPackage = true;
    vi.mocked(resourceApi.list).mockImplementation(async (type, query) => {
      if (type === 'finance-categories') return list([]);
      if (query.tab === 'raw') return new Promise(resolve => { finishRaw = resolve; });
      if (failPackage) throw new Error('合成读取失败');
      return list([record(8, '新包装选项', { archiveType: 'package' })]);
    });
    const { rerender } = render(<FinanceCompositionPicker group="raw" value={null} onChange={vi.fn()}/>);
    fireEvent.focus(screen.getByRole('combobox'));
    await waitFor(() => expect(finishRaw).toBeTruthy());
    compositionAuth.companyId = 2;
    rerender(<FinanceCompositionPicker group="package" value={null} onChange={vi.fn()}/>);
    await screen.findByRole('alert');
    failPackage = false; fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('option', { name: /新包装选项/ });
    await act(async () => { finishRaw(list([record(9, '旧原料迟到', { archiveType: 'raw' })])); });
    expect(screen.queryByText('旧原料迟到')).toBeNull();
  });

  it('空行使用倍数留空，选用后默认1，手填倍数在换选时保留；供应商OEM包装只保留直接搜索', async () => {
    vi.mocked(resourceApi.list).mockImplementation(async type => list(type === 'finance-products' ? [record(1, '合成OEM包装甲', { archiveType: 'oem_package' }), record(2, '合成OEM包装乙', { archiveType: 'oem_package' })] : []));
    function Form() { const [rows, setRows] = useState([blankBomRow('oem_package')]); return <BomDraft reference rows={rows} onChange={setRows} groups={['oem_package']} canCost={false}/>; }
    render(<Form/>);
    const qty = screen.getByRole('spinbutton', { name: '组成数量' }) as HTMLInputElement;
    expect(qty.value).toBe('');
    expect(screen.queryByRole('button', { name: '按分类选择' })).toBeNull();
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /合成OEM包装甲/ }));
    expect(qty.value).toBe('1');
    fireEvent.change(qty, { target: { value: '2.5' } });
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /合成OEM包装乙/ }));
    expect(qty.value).toBe('2.5');
  });
});
