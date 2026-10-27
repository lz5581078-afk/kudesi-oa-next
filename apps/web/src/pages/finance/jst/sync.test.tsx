import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JstSyncItems } from './JstSyncItems';
import { JstSyncExtras } from './JstSyncExtras';
import { jstApi } from './jstApi';

const auth = vi.hoisted(() => ({ admin: true, keys: ['finance.bundle-sync.manage'] as string[] }));
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: (k: string) => auth.admin || auth.keys.includes(k), user: { permissions: { isCompanyAdmin: auth.admin, allow: auth.keys, deny: [] } } }) }));
vi.mock('../../../api/client', async (orig) => {
  const real = await orig<typeof import('../../../api/client')>();
  return { ...real, api: vi.fn() };
});
vi.mock('./jstApi', async (orig) => {
  const real = await orig<typeof import('./jstApi')>();
  return { ...real, jstApi: { enqueue: vi.fn(), priceSwitch: vi.fn(), setPriceSwitch: vi.fn(), pricePreview: vi.fn(), priceRun: vi.fn(), priceLogs: vi.fn(), archiveJobs: vi.fn(), recheckArchive: vi.fn(), categoryPreview: vi.fn(), categoryExecute: vi.fn(), categoryRuns: vi.fn() } };
});
import { api } from '../../../api/client';
const m = vi.mocked(jstApi);
const apiMock = vi.mocked(api);
afterEach(() => { cleanup(); vi.clearAllMocks(); auth.admin = true; });

const item = (id: number, over: Record<string, unknown> = {}) => ({
  id, type: 'finance-bundles', code: `ZH-${id}`, name: `组合${id}`, state: 'not_synced', uploadedCode: null, replacing: false, signature: `sig${id}`, current: {}, uploaded: null, diff: [], records: [], ...over,
});

describe('同步清单：批量加入队列', () => {
  it('勾选后必须先确认已核对才能提交；提交带着每条的指纹', async () => {
    apiMock.mockResolvedValue({ total: 2, rows: [item(1), item(2, { state: 'synced', uploaded: {} })] });
    m.enqueue.mockResolvedValue({ queued: 1, skipped: 0 });
    render(<JstSyncItems onQueued={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('资料类型'), { target: { value: 'finance-bundles' } });
    const box = await screen.findByLabelText('选择 ZH-1');
    expect(screen.queryByLabelText('选择 ZH-2')).toBeNull(); // 已同步的不能选
    fireEvent.click(box);
    const go = screen.getByRole('button', { name: '加入同步队列' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我已核对这 1 条/));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(m.enqueue).toHaveBeenCalledWith('finance-bundles', [{ id: 1, signature: 'sig1' }], false));
  });

  it('没有组合装同步维护权限的人看不到勾选框', async () => {
    auth.admin = false; auth.keys = [];
    apiMock.mockResolvedValue({ total: 1, rows: [item(1)] });
    render(<JstSyncItems onQueued={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('资料类型'), { target: { value: 'finance-bundles' } });
    await screen.findByText('ZH-1', { exact: false });
    expect(screen.queryByLabelText('选择 ZH-1')).toBeNull();
  });
});

describe('基本售价、归档任务、分类同步', () => {
  it('没有组合装同步维护权限时整块不显示', () => {
    auth.admin = false; auth.keys = [];
    const { container } = render(<JstSyncExtras onQueued={() => undefined} />);
    expect(container.textContent).toBe('');
  });

  it('基本售价：开关关着不能同步；被拦截的显示原因', async () => {
    m.priceSwitch.mockResolvedValue({ enabled: false, senderConfigured: false });
    m.pricePreview.mockResolvedValue({ rows: [{ bundleId: 1, code: 'ZH-1', name: '组合1', action: 'blocked', priceCents: null, currentCents: null, reason: '没有设置利润率' }] });
    m.priceLogs.mockResolvedValue({ total: 0, rows: [] });
    render(<JstSyncExtras onQueued={() => undefined} />);
    await screen.findByText('没有设置利润率');
    expect((screen.getByRole('button', { name: /现在同步一批/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/已关闭（默认）/)).toBeTruthy();
  });

  it('归档任务：失败的可以复查，成功的不显示复查', async () => {
    m.priceSwitch.mockResolvedValue({ enabled: false, senderConfigured: false });
    m.pricePreview.mockResolvedValue({ rows: [] });
    m.priceLogs.mockResolvedValue({ total: 0, rows: [] });
    m.archiveJobs.mockResolvedValue({ rows: [
      { id: 1, bundleId: 1, code: 'ZH-A', name: 'A', status: 'failed', message: '聚水潭禁用失败', reason: '不用了', actorName: '老板', createdAt: '2026-01-01T00:00:00Z' },
      { id: 2, bundleId: 2, code: 'ZH-B', name: 'B', status: 'success', message: '已禁用', reason: '不用了', actorName: '老板', createdAt: '2026-01-01T00:00:00Z' },
    ] });
    m.recheckArchive.mockResolvedValue({ ok: true, status: 'success', message: '已确认禁用' });
    render(<JstSyncExtras onQueued={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: '归档任务' }));
    await screen.findByText('ZH-A');
    expect(screen.getAllByRole('button', { name: '复查' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '复查' }));
    await waitFor(() => expect(m.recheckArchive).toHaveBeenCalledWith(1));
  });

  it('分类同步：有冲突不能提交；无冲突要先确认差异再入队', async () => {
    m.priceSwitch.mockResolvedValue({ enabled: false, senderConfigured: false });
    m.pricePreview.mockResolvedValue({ rows: [] });
    m.priceLogs.mockResolvedValue({ total: 0, rows: [] });
    m.categoryRuns.mockResolvedValue({ page: 1, rows: [] });
    render(<JstSyncExtras onQueued={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: '分类同步' }));
    m.categoryPreview.mockResolvedValueOnce({ scope: 'bundle', targetKey: 'k', signature: 's1', conflicts: 1, remoteOnly: 0, note: '', changes: [{ localId: '1', path: '礼盒', action: 'conflict', message: '聚水潭存在其他同名分类', before: null, after: null }] });
    fireEvent.click(screen.getByRole('button', { name: '查看差异' }));
    await screen.findByText('聚水潭存在其他同名分类');
    expect(screen.queryByRole('button', { name: '确认并加入队列' }) && (screen.getByRole('button', { name: '确认并加入队列' }) as HTMLButtonElement).disabled).toBe(true);
    m.categoryPreview.mockResolvedValueOnce({ scope: 'bundle', targetKey: 'k', signature: 's2', conflicts: 0, remoteOnly: 0, note: '', changes: [{ localId: '1', path: '礼盒', action: 'create', message: '', before: null, after: null }] });
    m.categoryExecute.mockResolvedValue({ runId: 1, queued: 1, retired: 0 });
    fireEvent.click(screen.getByRole('button', { name: '查看差异' }));
    await screen.findByText('新增');
    const go = screen.getByRole('button', { name: '确认并加入队列' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我已核对以上差异/));
    fireEvent.click(go);
    await waitFor(() => expect(m.categoryExecute).toHaveBeenCalledWith('bundle', 's2'));
  });
});

describe('同步清单：状态汇总、筛选与全选本页', () => {
  it('汇总来自服务端全量统计；状态筛选交给服务端；全选只选可同步的', async () => {
    const rows = [item(1), item(2, { state: 'synced', uploaded: {} }), item(3, { state: 'failed' })];
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes('/items/summary')) return { total: 120, counts: { not_synced: 80, synced: 30, failed: 10 } };
      if (path.includes('state=synced')) return { total: 30, rows: [rows[1]] };
      return { total: 120, rows };
    });
    render(<JstSyncItems onQueued={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('资料类型'), { target: { value: 'finance-bundles' } });
    await screen.findByText(/共 120 条已验证：未同步 80 · 已同步 30 · 同步失败 10/);
    fireEvent.click(await screen.findByLabelText('全选本页可同步的'));
    expect(screen.getByText(/已选 2 条/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('同步状态'), { target: { value: 'synced' } });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('state=synced')));
    await waitFor(() => expect(screen.queryByText('ZH-1', { exact: false })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    await screen.findByText('ZH-1', { exact: false });
  });
});

describe('飞书通知开关', () => {
  it('默认关；没接入飞书时提示只积压；管理员打开前要确认，非管理员看不到按钮', async () => {
    const { FeishuSwitchCard } = await import('./FeishuSwitchCard');
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => (opts?.method === 'PUT' ? { enabled: true, senderConfigured: false } : { enabled: false, senderConfigured: false, counts: {} }) as never);
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FeishuSwitchCard />);
    await screen.findByText(/已关闭（默认）/);
    expect(screen.getByText(/不会发送/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开飞书通知' }));
    await screen.findByText(/已打开/);
    expect(apiMock).toHaveBeenCalledWith('/finance/feishu-notice/switch', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ enabled: true }) }));
    expect(ask).toHaveBeenCalled();
    cleanup();
    auth.admin = false;
    render(<FeishuSwitchCard />);
    await screen.findByText(/飞书通知：/);
    expect(screen.queryByRole('button', { name: /飞书通知/ })).toBeNull();
    ask.mockRestore();
  });
});
