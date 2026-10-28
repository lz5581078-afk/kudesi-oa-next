import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./RecordForm', () => ({ RecordForm: () => <div>表单</div>, loadRefOptions: async () => [] }));
vi.mock('./RecordDetail', () => ({
  RecordDetail: ({ id, nav }: { id: number; nav?: { index: number; total: number; onNext?: () => void; onPrev?: () => void } }) => (
    <div>详情{id}<span>{nav ? `${nav.index}/${nav.total}` : ''}</span>{nav?.onNext && <button type="button" onClick={nav.onNext}>下一条</button>}</div>
  ),
  useResourceCan: () => () => true,
}));
vi.mock('./CategoryTree', () => ({ CategoryTree: () => null }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), users: vi.fn().mockResolvedValue([]), export: vi.fn() } };
});
import { ResourcePage } from './ResourcePage';

const mk = (id: number, number: string) => ({ id, type: 'phones', title: number, status: 'normal', statusReason: null, data: { number, carrier: '移动', usageType: 'company_kept' }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' });
const rows = [mk(7, '13800138000'), mk(8, '13900139000')];
const list = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20, tabCounts: {} }) as never;
const page = () => render(<MemoryRouter><ResourcePage type="phones" /></MemoryRouter>);

beforeEach(() => {
  localStorage.clear();
  vi.mocked(resourceApi.list).mockResolvedValue(list(rows));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('资料列表布局', () => {
  it('不再有大标题和说明段落；工具条只有一行，表格和分页在同一个页面里', async () => {
    page();
    await screen.findAllByRole('button', { name: '复制号码' });
    expect(document.querySelector('.res-page h1, .res-page .page-title, .res-page .page-desc')).toBeNull();
    expect(document.querySelectorAll('.res-bar').length).toBeLessThanOrEqual(2);
    expect(document.querySelector('.res-main table')).toBeTruthy();
    expect(document.querySelector('.res-foot')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下一页' })).toBeTruthy();
  });

  it('筛选收进“筛选”按钮的弹层：默认不占位，选了条件出现可单独清除的标签并带数量', async () => {
    page();
    await screen.findAllByRole('button', { name: '复制号码' });
    expect(screen.queryByLabelText('状态')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^筛选/ }));
    const dlg = screen.getByRole('dialog', { name: /筛选/ });
    fireEvent.change(within(dlg).getByLabelText('状态'), { target: { value: 'normal' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '筛选 1' })).toBeTruthy());
    const chip = document.querySelector('.res-chips .res-chip button') as HTMLButtonElement;
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByRole('button', { name: '筛选' })).toBeTruthy());
  });

  it('行高可切换（紧凑/舒适）并记住', async () => {
    const first = page();
    await screen.findAllByRole('button', { name: '复制号码' });
    fireEvent.click(screen.getByRole('button', { name: /行高：/ }));
    const saved = localStorage.getItem('kudesi.list.density');
    expect(saved).toBeTruthy();
    first.unmount();
    page();
    await screen.findAllByRole('button', { name: '复制号码' });
    expect(localStorage.getItem('kudesi.list.density')).toBe(saved);
  });

  it('第一列固定，表头可点排序、有列宽拖动柄', async () => {
    page();
    await screen.findAllByRole('button', { name: '复制号码' });
    expect(document.querySelector('tbody td.frozen.first')).toBeTruthy();
    expect(document.querySelector('thead .th-sort')).toBeTruthy();
    expect(document.querySelector('thead .col-grip')).toBeTruthy();
  });

  it('打开详情后可用“下一条”切到下一行，位置显示 1/2 → 2/2', async () => {
    page();
    fireEvent.click(await screen.findByText('13800138000'));
    expect(await screen.findByText('详情7')).toBeTruthy();
    expect(screen.getByText('1/2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一条' }));
    expect(await screen.findByText('详情8')).toBeTruthy();
    expect(screen.getByText('2/2')).toBeTruthy();
  });

  it('手机：按卡片显示，筛选入口仍在一行里', async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
    try {
      page();
      await screen.findByText('13800138000');
      expect(document.querySelector('.res-cards')).toBeTruthy();
      expect(document.querySelector('.res-main table')).toBeNull();
      expect(screen.getByRole('button', { name: /^筛选/ })).toBeTruthy();
    } finally { window.matchMedia = mm; }
  });
});
