import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { AgentReleasePanel } from './AgentReleasePanel';
import { sessionApi } from './sessionApi';

vi.mock('./sessionApi', () => ({ sessionApi: { releases: vi.fn(), publishRelease: vi.fn(), withdrawRelease: vi.fn() } }));
const m = vi.mocked(sessionApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const rel = { id: 1, version: '1.2.0', sha256: 'a'.repeat(64), size: 4096, notes: '修复', createdAt: '2026-10-26T00:00:00Z', withdrawnAt: null, createdByName: '老板', isLatest: true };

describe('助手安装包面板', () => {
  it('显示最新版；上传时带上填写的 SHA-256，成功后刷新并通知父组件', async () => {
    m.releases.mockResolvedValue([rel]);
    m.publishRelease.mockResolvedValue({ version: '1.3.0', sha256: 'b'.repeat(64), size: 10 });
    const onChange = vi.fn();
    render(<AgentReleasePanel onChange={onChange} />);
    await screen.findByText(/当前最新 v1\.2\.0/);
    fireEvent.change(screen.getByLabelText('选择升级包'), { target: { files: [new File([new Uint8Array([1])], 'a.kapkg')] } });
    fireEvent.change(screen.getByLabelText('SHA-256'), { target: { value: ` ${'b'.repeat(64)} ` } });
    fireEvent.click(screen.getByRole('button', { name: '上传并发布' }));
    await screen.findByText(/已发布 v1\.3\.0/);
    expect(m.publishRelease.mock.calls[0][1]).toEqual({ sha256: 'b'.repeat(64), notes: undefined });
    expect(onChange).toHaveBeenCalled();
  });
  it('服务器拒绝（哈希不符等）时显示原因；没选文件不发请求', async () => {
    m.releases.mockResolvedValue([]);
    m.publishRelease.mockRejectedValue(new ApiError(400, 'SHA-256 与上传的文件不一致'));
    render(<AgentReleasePanel />);
    fireEvent.click(screen.getByRole('button', { name: '上传并发布' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/请先选择/);
    expect(m.publishRelease).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('选择升级包'), { target: { files: [new File([new Uint8Array([1])], 'a.kapkg')] } });
    fireEvent.click(screen.getByRole('button', { name: '上传并发布' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/不一致/));
  });
});
