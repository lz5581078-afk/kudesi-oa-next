import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ changeStatus: vi.fn() }));
vi.mock('./api', async (orig) => { const m = await orig<typeof import('./api')>(); return { ...m, resourceApi: { ...m.resourceApi, ...api } }; });
import { ArchiveStatusButtons, rowActionsFor } from './RowActions';
import type { ResourceDto } from './api';

const row = (over: Partial<ResourceDto>) => ({ id: 5, title: '合同甲', status: 'stored', ...over } as ResourceDto);

describe('列表行内办理', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('档案：在库的可借出/遗失；借出、遗失要写原因才提交', async () => {
    api.changeStatus.mockResolvedValue({});
    const done = vi.fn();
    render(<ArchiveStatusButtons row={row({})} onDone={done} />);
    expect(screen.queryByRole('button', { name: '在库：合同甲' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '借出：合同甲' }));
    expect(api.changeStatus).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '借给财务对账' } });
    fireEvent.click(screen.getByRole('button', { name: '确认借出' }));
    await waitFor(() => expect(api.changeStatus).toHaveBeenCalledWith('archives', 5, 'borrowed', '借给财务对账'));
    expect(done).toHaveBeenCalled();
  });

  it('档案：借出的可以直接还回在库，不需要原因', async () => {
    api.changeStatus.mockResolvedValue({});
    render(<ArchiveStatusButtons row={row({ status: 'borrowed' })} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '在库：合同甲' }));
    await waitFor(() => expect(api.changeStatus).toHaveBeenCalledWith('archives', 5, 'stored', undefined));
  });

  it('已归档的档案不再给办理按钮', () => {
    const { container } = render(<ArchiveStatusButtons row={row({ status: 'archived' })} onDone={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('只有有对应权限才出现办理列', () => {
    expect(rowActionsFor('fixed-assets', () => false, vi.fn())).toBeUndefined();
    expect(rowActionsFor('fixed-assets', () => true, vi.fn())).toBeTypeOf('function');
    expect(rowActionsFor('archives', (a) => a === 'disable', vi.fn())).toBeTypeOf('function');
    expect(rowActionsFor('stores', () => true, vi.fn())).toBeUndefined();
  });

  it('固定资产：按当前状态给动作；已报废显示已报废', () => {
    const f = rowActionsFor('fixed-assets', () => true, vi.fn())!;
    render(<>{f(row({ status: 'idle', title: '电脑' }))}{f(row({ id: 6, status: 'retired', title: '旧机' }))}</>);
    expect(screen.getByRole('button', { name: /领用：电脑/ })).toBeTruthy();
    expect(screen.getByText('已报废')).toBeTruthy();
  });
});
