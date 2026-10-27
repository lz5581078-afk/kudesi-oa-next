import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';

const dl = vi.fn();
vi.mock('./csv', async (orig) => ({ ...(await orig<typeof import('./csv')>()), downloadText: (...a: unknown[]) => dl(...a) }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, import: vi.fn(), importBackups: vi.fn().mockResolvedValue([]) } };
});
import { resourceApi } from './api';
import { ImportDialog } from './ImportDialog';

beforeEach(() => vi.mocked(resourceApi.import).mockResolvedValue({ dryRun: true, committed: false, created: 1, updated: 0, failed: 1, results: [{ line: 2, action: 'create', errors: [] }, { line: 3, action: 'error', errors: ['名称必填'] }] } as never));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const csv = (name = '供应商.csv', body = '供应商名称\n甲\n') => {
  const f = new File([body], name, { type: 'text/csv' });
  (f as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => new TextEncoder().encode(body).buffer as ArrayBuffer;
  return f;
};

describe('导入向导', () => {
  it('拖入文件后显示文件名，预检有错时能下载错误报告，也能放弃此文件', async () => {
    render(<ImportDialog def={getResourceDef('finance-suppliers')!} onClose={() => undefined} onDone={() => undefined} />);
    const zone = screen.getByText(/拖到这里/).closest('.import-drop')!;
    fireEvent.drop(zone, { dataTransfer: { files: [csv()] } });
    await screen.findByText(/已选：供应商\.csv/);
    await screen.findByText('下载错误报告 (CSV)');
    fireEvent.click(screen.getByText('下载错误报告 (CSV)'));
    expect(dl).toHaveBeenCalledWith('供应商档案-导入错误报告.csv', expect.stringContaining('名称必填'));
    fireEvent.click(screen.getByText('放弃此文件'));
    expect(screen.queryByText(/已选：/)).toBeNull();
  });
  it('一次拖两个文件被拒绝；超过 10MB 被拒绝', async () => {
    render(<ImportDialog def={getResourceDef('finance-suppliers')!} onClose={() => undefined} onDone={() => undefined} />);
    const zone = screen.getByText(/拖到这里/).closest('.import-drop')!;
    fireEvent.drop(zone, { dataTransfer: { files: [csv(), csv('b.csv')] } });
    await screen.findByText('一次只能导入一个文件，请只拖入一个');
    const big = csv('big.csv');
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.drop(zone, { dataTransfer: { files: [big] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('超过 10 MB'));
    expect(vi.mocked(resourceApi.import).mock.calls.filter((c) => c.length > 0)).toHaveLength(0);
  });
  it('“只看有问题的行”：打开后正常行不显示', async () => {
    vi.mocked(resourceApi.import).mockResolvedValue({ dryRun: true, committed: false, created: 2, updated: 0, failed: 1, results: [{ line: 2, action: 'create', errors: [], title: '正常甲' }, { line: 3, action: 'error', errors: ['名称必填'] }, { line: 4, action: 'create', errors: [], title: '正常乙' }] } as never);
    render(<ImportDialog def={getResourceDef('finance-suppliers')!} onClose={() => undefined} onDone={() => undefined} />);
    fireEvent.drop(screen.getByText(/拖到这里/).closest('.import-drop')!, { dataTransfer: { files: [csv()] } });
    await screen.findByText('正常甲');
    fireEvent.click(screen.getByLabelText(/只看有问题的行/));
    expect(screen.queryByText('正常甲')).toBeNull();
    expect(screen.getByText('名称必填')).toBeTruthy();
  });
});
