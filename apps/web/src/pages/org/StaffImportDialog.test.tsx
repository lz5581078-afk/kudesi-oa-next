import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const importStaff = vi.fn();
vi.mock('./orgApi', async (orig) => ({ ...(await orig<typeof import('./orgApi')>()), orgApi: { importStaff: (...a: unknown[]) => importStaff(...a) } }));
import { StaffImportDialog } from './StaffImportDialog';

afterEach(() => { cleanup(); importStaff.mockReset(); });

describe('员工导入', () => {
  it('先预检再确认导入；新账号的初始密码在导入完成后显示', async () => {
    importStaff
      .mockResolvedValueOnce({ dryRun: true, summary: { create: 1, update: 0, skip: 0, error: 0 }, rows: [{ line: 2, name: '新人', account: 'new1', action: 'create', message: '新增员工' }] })
      .mockResolvedValueOnce({ dryRun: false, summary: { create: 1, update: 0, skip: 0, error: 0 }, rows: [{ line: 2, name: '新人', account: 'new1', action: 'create', message: '新增员工', initialPassword: 'Abc123Xyz789' }] });
    const onDone = vi.fn();
    render(<StaffImportDialog onClose={() => undefined} onDone={onDone} />);
    const confirm = screen.getByRole('button', { name: '确认导入' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const file = new File(['姓名,登录账号\n新人,new1'], 'staff.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => '姓名,登录账号\n新人,new1' });
    fireEvent.change(screen.getByLabelText('选择 CSV 文件'), { target: { files: [file] } });
    await waitFor(() => expect((screen.getByRole('button', { name: '预检' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '预检' }));
    await screen.findByText(/还没有写入/);
    expect(importStaff).toHaveBeenLastCalledWith('姓名,登录账号\n新人,new1', true);
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await screen.findByText('Abc123Xyz789');
    expect(importStaff).toHaveBeenLastCalledWith('姓名,登录账号\n新人,new1', false);
    expect(onDone).toHaveBeenCalled();
  });
});
