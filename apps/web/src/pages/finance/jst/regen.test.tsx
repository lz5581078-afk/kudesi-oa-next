import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CategorySortDialog } from '../../../resources/CategorySortDialog';
import { BundleRegenDialog } from './BundleRegenDialog';
import { jstApi } from './jstApi';

vi.mock('./jstApi', async (orig) => {
  const real = await orig<typeof import('./jstApi')>();
  return { ...real, jstApi: { regenPreview: vi.fn(), regenExecute: vi.fn(), categoryTree: vi.fn(), categoryReorder: vi.fn() } };
});
const m = vi.mocked(jstApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const row = (id: number, over: Record<string, unknown> = {}) => ({ id, status: 'verified', oldCode: `ZH-${id}`, newCode: `QQ-${id}`, oldName: `旧${id}`, newName: `新${id}`, uploadedCode: null, token: `t${id}`, error: null, blocked: null, ...over });

describe('按新命名规则批量重生成编码', () => {
  it('先预览；选中后必须写原因并勾选确认才能执行；带着预览指纹提交；被拦住的不能选', async () => {
    m.regenPreview.mockResolvedValue({ rows: [row(1), row(2, { blocked: '还有没发送完的聚水潭同步任务' })] });
    m.regenExecute.mockResolvedValue({ results: [{ id: 1, ok: true, code: 'QQ-1' }], done: 1, failed: 0 });
    render(<BundleRegenDialog onClose={() => undefined} onDone={() => undefined} />);
    await screen.findByText('QQ-1');
    expect((screen.getByLabelText('选择 ZH-2') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('选择 ZH-1'));
    const go = screen.getByRole('button', { name: /重新生成/ }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('重生成原因'), { target: { value: '规则调整' } });
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我已核对以上 1 个/));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(m.regenExecute).toHaveBeenCalledWith([{ id: 1, token: 't1' }], '规则调整'));
  });
});

describe('分类顺序调整', () => {
  it('▲▼只在同一上级内移动，调整后把这一组兄弟的新顺序交给服务端', async () => {
    m.categoryTree.mockResolvedValue({ nodes: [
      { id: 1, name: '水果', code: 'SG', parentId: 0, sort: 10, status: 'active' },
      { id: 2, name: '苹果类', code: 'PG', parentId: 1, sort: 10, status: 'active' },
      { id: 3, name: '梨类', code: 'LG', parentId: 1, sort: 20, status: 'active' },
    ] });
    m.categoryReorder.mockResolvedValue({ ok: true, changed: 2 });
    render(<CategorySortDialog archiveType="raw" onClose={() => undefined} onDone={() => undefined} />);
    await screen.findByText('梨类');
    expect((screen.getByLabelText('上移 苹果类') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('下移 水果') as HTMLButtonElement).disabled).toBe(true); // 只有一个一级分类
    fireEvent.click(screen.getByLabelText('上移 梨类'));
    await waitFor(() => expect(m.categoryReorder).toHaveBeenCalledWith([3, 2]));
  });
});
