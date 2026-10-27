import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.fn();
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: (...a: unknown[]) => apiMock(...a) }));
const downloadXlsx = vi.fn();
vi.mock('./xlsx', () => ({
  downloadXlsx: (...a: unknown[]) => downloadXlsx(...a),
  readXlsxRows: vi.fn().mockResolvedValue([['档案编号', '成本类型', '单位成本', '计价单位', '生效开始'], ['YL-1', '采购成本', '1.5', '千克', '2026-01-01']]),
}));
import { ProductCostExcelDialog } from './ProductCostExcelDialog';

afterEach(() => { cleanup(); apiMock.mockReset(); downloadXlsx.mockReset(); });

describe('商品档案成本 Excel', () => {
  it('导出：下载服务端给的表头和行', async () => {
    apiMock.mockResolvedValue({ headers: ['档案编号'], rows: [['YL-1']] });
    render(<ProductCostExcelDialog canImport onClose={() => undefined} onDone={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '导出全部成本记录' }));
    await waitFor(() => expect(downloadXlsx).toHaveBeenCalledWith('商品档案成本记录.xlsx', [['档案编号'], ['YL-1']]));
  });

  it('选文件先预检，没问题才出现确认导入；导入后提示结果', async () => {
    const onDone = vi.fn();
    apiMock.mockResolvedValueOnce({ errors: [], warnings: [], created: 1, updated: 0, rowCount: 1, confirm: 'IMPORT-X' }).mockResolvedValueOnce({ errors: [], warnings: [], created: 1, updated: 0, rowCount: 1 });
    render(<ProductCostExcelDialog canImport onClose={() => undefined} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('选择档案成本文件'), { target: { files: [new File(['x'], 'a.xlsx')] } });
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    await screen.findByText(/导入完成：新增 1 条/);
    expect(apiMock.mock.calls[1][1].body.confirm).toBe('IMPORT-X');
    expect(onDone).toHaveBeenCalled();
  });

  it('没有导入权限：不显示模板和导入', () => {
    render(<ProductCostExcelDialog canImport={false} onClose={() => undefined} onDone={() => undefined} />);
    expect(screen.queryByRole('button', { name: '选择文件并预检' })).toBeNull();
  });
});
