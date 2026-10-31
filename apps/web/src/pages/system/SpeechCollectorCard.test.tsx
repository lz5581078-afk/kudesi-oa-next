import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpeechCollectorCard } from './SpeechCollectorCard';
import { api } from '../../api/client';
vi.mock('../../api/client', () => ({ api: vi.fn() }));
const state = { configured: true, enabled: true, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20 };
describe('OA 采集器语音设置', () => {
  afterEach(cleanup);
  beforeEach(() => { vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue(state); });
  it('展示两种模式及配置状态，密钥为空；保存后清空输入', async () => {
    render(<SpeechCollectorCard canEdit />);
    const input = await screen.findByLabelText('豆包语音 API Key'); expect((input as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/允许分段识别/) as HTMLInputElement).checked).toBe(true); expect((screen.getByLabelText(/允许实时识别/) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(input, { target: { value: 'test-only-new-key' } }); fireEvent.click(screen.getByText('保存语音设置'));
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith('/settings/integrations/speech', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ apiKey: 'test-only-new-key' }) })));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });
  it('无修改权限时所有字段只读且没有保存按钮', async () => {
    render(<SpeechCollectorCard canEdit={false} />); expect((await screen.findByLabelText('豆包语音 API Key') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/启用公司云端/) as HTMLInputElement).disabled).toBe(true); expect(screen.queryByText('保存语音设置')).toBeNull();
  });
  it('加载失败显示错误，不出现可提交的空配置', async () => {
    vi.mocked(api).mockRejectedValue(new Error('没有查看权限')); render(<SpeechCollectorCard canEdit />);
    expect((await screen.findByRole('alert')).textContent).toContain('没有查看权限'); expect(screen.queryByText('保存语音设置')).toBeNull();
  });
});
