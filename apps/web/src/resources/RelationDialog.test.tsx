import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { RelationDialog, composePurpose, parsePurpose } from './RelationDialog';

vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, updateLink: vi.fn().mockResolvedValue({ ok: true }), addLink: vi.fn().mockResolvedValue({ ok: true }), users: vi.fn().mockResolvedValue([{ id: 5, name: '小王', active: true }]), list: vi.fn() } };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('关联属性对话框', () => {
  it('关系类型存取：写在用途开头，读出来能还原', () => {
    expect(composePurpose('授权', '给拼店')).toBe('【授权】给拼店');
    expect(parsePurpose('【授权】给拼店')).toEqual({ kind: '授权', text: '给拼店' });
    expect(parsePurpose('旧文字')).toEqual({ kind: '其他', text: '旧文字' });
  });

  it('修改：关系类型单选，结束早于开始不能保存，保存后带关系类型/起止/用途', async () => {
    const onSaved = vi.fn();
    render(<RelationDialog type="trademarks" id={1} link={{ linkId: 9, title: '店A', purpose: '【使用】旧', validFrom: '2026-01-01', validTo: '2026-12-31' }} canView={() => true} onClose={() => undefined} onSaved={onSaved} />);
    expect((screen.getByRole('radio', { name: '使用' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '授权' }));
    fireEvent.change(screen.getByLabelText('有效期结束'), { target: { value: '2025-01-01' } });
    expect(screen.getAllByText('结束日期不能早于开始日期').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(resourceApi.updateLink).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('有效期结束'), { target: { value: '2026-06-30' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(resourceApi.updateLink).toHaveBeenCalledWith('trademarks', 1, 9, { purpose: '【授权】旧', validFrom: '2026-01-01', validTo: '2026-06-30' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('添加：没选对象不能保存', async () => {
    render(<RelationDialog type="trademarks" id={1} canView={() => true} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('请选择要关联的资料')).toBeTruthy();
    expect(resourceApi.addLink).not.toHaveBeenCalled();
  });
});
