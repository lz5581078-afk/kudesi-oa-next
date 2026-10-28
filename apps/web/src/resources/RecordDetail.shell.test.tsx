import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, get: vi.fn(), relations: vi.fn(), logs: vi.fn(), reveal: vi.fn() } };
});
import { RecordDetail } from './RecordDetail';

const def = getResourceDef('bank-accounts')!;
const rec = { id: 3, type: 'bank-accounts', title: '工行 5678', status: 'normal', statusReason: null, data: { accountNo: '6222020200015678', bank: '工商银行' }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' };
const show = (onClose = vi.fn()) => render(<MemoryRouter><RecordDetail def={def} id={3} onClose={onClose} onChanged={() => undefined} /></MemoryRouter>);

beforeEach(() => {
  vi.mocked(resourceApi.get).mockResolvedValue(rec as never);
  vi.mocked(resourceApi.relations).mockResolvedValue([{ direction: 'out', relation: 'ref', type: 'licenses', id: 1, title: '某某公司' }, { direction: 'in', relation: 'ref', type: 'stores', id: 2, title: '店A' }] as never);
  vi.mocked(resourceApi.logs).mockResolvedValue([
    { id: '2', action: 'update', actor: '张三', note: null, createdAt: '2026-10-01T02:00:00Z', before: { bank: '工商银行' }, after: { bank: '建设银行' } },
    { id: '1', action: 'create', actor: '', note: null, createdAt: '2026-09-01T02:00:00Z' },
  ] as never);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('资料详情通用壳', () => {
  it('卡号/账号在详情里有复制按钮，一键复制完整值', async () => {
    show();
    const btns = await screen.findAllByRole('button', { name: '复制账号/卡号' });
    fireEvent.click(btns[btns.length - 1]);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('6222020200015678'));
  });

  it('关联页签带数量，不用点进去才知道有没有关联', async () => {
    show();
    expect(await screen.findByRole('tab', { name: '关联 2' })).toBeTruthy();
  });

  it('操作记录里列出改了哪些字段（旧值 → 新值），没有操作人显示系统', async () => {
    show();
    fireEvent.click(await screen.findByRole('tab', { name: '操作记录' }));
    expect(await screen.findByText(/开户行：工商银行 → 建设银行/)).toBeTruthy();
    expect(screen.getByText(/^系统/)).toBeTruthy();
  });

  it('按 Esc 关闭详情；手机上有“返回列表”', async () => {
    const onClose = vi.fn();
    show(onClose);
    await screen.findByRole('tab', { name: '操作记录' });
    expect(screen.getByRole('button', { name: '← 返回列表' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('资料已不存在时给出明确提示，其他错误可重新加载', async () => {
    vi.mocked(resourceApi.get).mockRejectedValueOnce(Object.assign(new (await import('../api/client')).ApiError(404, '记录不存在'), {}));
    show();
    expect(await screen.findByText(/已经不存在/)).toBeTruthy();
  });

  it('展开全宽、分区导航：展开按钮切换全宽；有多个分区时出现分区导航', async () => {
    show();
    await screen.findByText('工行 5678', { selector: '.rd-title' });
    const btn = screen.getByRole('button', { name: '展开到全宽' });
    fireEvent.click(btn);
    expect(document.querySelector('.rd-wide')).toBeTruthy();
    expect(screen.getByRole('button', { name: '还原宽度' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '分区导航' })).toBeTruthy();
  });

  it('逐区就地编辑：点“编辑本区”只把这一区变成表单（不弹窗），取消后回到只读', async () => {
    show();
    const edit = (await screen.findAllByRole('button', { name: /^编辑/ }).then((l) => l.find((b) => b.textContent === '编辑本区')))!;
    fireEvent.click(edit);
    expect(document.querySelector('.inline-form')).toBeTruthy();
    expect(document.querySelector('.modal-backdrop')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(document.querySelector('.inline-form')).toBeNull());
  });
});
