import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { PackagingExcelDialog } from './PackagingExcelDialog';

vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: vi.fn() }));
vi.mock('read-excel-file', () => {
  const tables: Record<string, string[][]> = {
    包装方案: [['方案编码', '方案名称', '使用场景', '商品分类', '品牌', '生效日期', '失效日期', '状态', '来源类型', '来源说明', '备注'], ['A1', '方案甲', '发货包装', '', '', '', '', '启用', '', '', '']],
    包装方案明细: [['方案编码', '包装档案编号', '角色', '数量', '单位', '损耗率', '成本归类', '计价处理', '来源行', '排序', '备注'], ['A1', 'BZ0001', '包装', '2', '', '', '', '', '', '', '']],
    匹配规则: [['方案编码', '目标类型', '目标编码', '商品分类', '品牌', '销售场景', '最小重量kg', '最大重量kg', '离散重量kg', '优先级', '状态', '备注']],
  };
  return { default: async (_f: File, o: { sheet: string }) => tables[o.sheet], readSheetNames: async () => Object.keys(tables) };
});
const m = vi.mocked(api);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('包装方案 Excel 导入', () => {
  it('选文件后先预检，显示问题；没问题才出现确认导入，导入带确认码', async () => {
    m.mockImplementation(async (path: string) => {
      if (path.endsWith('preflight')) return { errors: [], warnings: [{ sheet: '包装方案', row: 2, field: '方案编码', message: '没有明细' }], summary: { schemesCreated: 1, schemesUpdated: 0, lines: 1, rules: 0 }, confirm: 'IMPORT-PACKAGING-ABCD1234' } as never;
      return { errors: [], warnings: [], summary: { schemesCreated: 1, schemesUpdated: 0, lines: 1, rules: 0 } } as never;
    });
    const onDone = vi.fn();
    render(<PackagingExcelDialog canCreate onClose={vi.fn()} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('选择包装方案文件'), { target: { files: [new File(['x'], 'a.xlsx')] } });
    await screen.findByText(/预检：新建方案 1/);
    expect(m).toHaveBeenCalledWith('/finance/packaging/import/preflight', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ schemes: [expect.objectContaining({ 方案编码: 'A1' })], lines: [expect.objectContaining({ 包装档案编号: 'BZ0001' })], rules: [] }) }));
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(m).toHaveBeenCalledWith('/finance/packaging/import/execute', expect.objectContaining({ body: expect.objectContaining({ confirm: 'IMPORT-PACKAGING-ABCD1234' }) })));
    await screen.findByText(/导入完成：新建方案 1/);
    expect(onDone).toHaveBeenCalled();
  });
  it('预检有问题时不给确认导入按钮', async () => {
    m.mockResolvedValue({ errors: [{ sheet: '包装方案明细', row: 2, field: '包装档案编号', message: '不存在' }], warnings: [], summary: { schemesCreated: 0, schemesUpdated: 0, lines: 0, rules: 0 }, confirm: null } as never);
    render(<PackagingExcelDialog canCreate onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择包装方案文件'), { target: { files: [new File(['x'], 'a.xlsx')] } });
    await screen.findByText(/包装方案明细 第 2 行「包装档案编号」 不存在/);
    expect(screen.queryByRole('button', { name: '确认导入' })).toBeNull();
  });
});
