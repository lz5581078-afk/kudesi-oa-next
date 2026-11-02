import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeskAccessDialog } from './DeskAccessDialog';
import { orgApi } from './orgApi';
vi.mock('./orgApi', () => ({ orgApi: { deskAccessPreview: vi.fn(), applyDeskAccess: vi.fn() } }));
const plan = { companyId: 1, companyName: '测试公司', fingerprint: 'a'.repeat(64), positions: [{ id: 1, name: '人事主管', departmentName: '人事部', workspaceType: 'general', preserved: true, before: ['live.manage'], after: ['live.manage'], added: [], removed: [], pages: [] }], staff: [], protectedDepartments: ['人事部'], changedPositions: 0, changedStaff: 0 };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('岗位功能授权预览', () => {
  it('展示人事保留和公司范围，核对前不能应用；只提交服务端计划指纹', async () => {
    vi.mocked(orgApi.deskAccessPreview).mockResolvedValue(plan);
    vi.mocked(orgApi.applyDeskAccess).mockResolvedValue({ changedPositions: 0, changedStaff: 0 });
    const applied = vi.fn(); render(<DeskAccessDialog catalog={[]} onClose={vi.fn()} onApplied={applied} />);
    expect(await screen.findByText('人事主管')).toBeTruthy();
    const button = screen.getByRole('button', { name: '确认按预览配置' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(button);
    expect(await screen.findByText(/配置已保存/)).toBeTruthy();
    expect(orgApi.applyDeskAccess).toHaveBeenCalledWith(plan.fingerprint); expect(applied).toHaveBeenCalledOnce();
  });
  it('旧预览冲突后不能再次提交，提示重新预览', async () => {
    vi.mocked(orgApi.deskAccessPreview).mockResolvedValue(plan);
    vi.mocked(orgApi.applyDeskAccess).mockRejectedValue(new Error('changed'));
    render(<DeskAccessDialog catalog={[]} onClose={vi.fn()} onApplied={vi.fn()} />);
    await screen.findByText('人事主管'); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: '确认按预览配置' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认按预览配置' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
