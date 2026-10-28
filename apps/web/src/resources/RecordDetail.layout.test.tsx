import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const show = (nav?: { index: number; total: number; onPrev?: () => void; onNext?: () => void }, onClose = vi.fn()) =>
  render(<MemoryRouter><RecordDetail def={def} id={3} nav={nav} onClose={onClose} onChanged={() => undefined} /></MemoryRouter>);

beforeEach(() => {
  vi.mocked(resourceApi.get).mockResolvedValue(rec as never);
  vi.mocked(resourceApi.relations).mockResolvedValue([] as never);
  vi.mocked(resourceApi.logs).mockResolvedValue([] as never);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('资料详情布局', () => {
  it('固定头部：名称、状态、主要操作；其余操作收进“更多”', async () => {
    show();
    await screen.findByText('工行 5678', { selector: '.rd-title' });
    const head = document.querySelector('.rd-head')!;
    expect(head.textContent).toContain('更多');
  });

  it('分页签：详情 / 关联 / 操作记录；操作记录不再和字段堆在一页', async () => {
    show();
    await screen.findByRole('tablist', { name: '详情分区' });
    expect(screen.getByRole('tab', { name: '操作记录' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^关联/ })).toBeTruthy();
    expect(document.querySelector('.rd-logs')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '操作记录' }));
    expect(screen.getByRole('tab', { name: '操作记录' }).getAttribute('aria-selected')).toBe('true');
  });

  it('字段用紧凑网格排列', async () => {
    show();
    await screen.findByText('工行 5678', { selector: '.rd-title' });
    expect(document.querySelector('dl.rd-grid .rd-item')).toBeTruthy();
  });

  it('上一条/下一条按钮与 ↑ ↓ 快捷键；显示位置；第一条上一条不可点', async () => {
    const onNext = vi.fn();
    show({ index: 1, total: 5, onNext });
    await screen.findByText('工行 5678', { selector: '.rd-title' });
    expect((screen.getByRole('button', { name: '上一条' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('第 1 条，共 5 条')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一条' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it('输入框里按 ↓ 不切换记录；Esc 关闭', async () => {
    const onNext = vi.fn();
    const onClose = vi.fn();
    show({ index: 1, total: 2, onNext }, onClose);
    await screen.findByText('工行 5678', { selector: '.rd-title' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onNext).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    input.remove();
  });
});
