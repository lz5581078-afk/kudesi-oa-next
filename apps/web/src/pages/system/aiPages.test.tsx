import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from './aiApi';
import { AiApiPage } from './AiApiPage';
import { OcrSettingsPage } from './OcrSettingsPage';

vi.mock('./aiApi', () => ({ aiApi: { overview: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), models: vi.fn(), sync: vi.fn(), setSwitch: vi.fn(), defaults: vi.fn(), setDefault: vi.fn() } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
const a = vi.mocked(aiApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const provider = { id: 1, providerKey: 'geek', name: 'GeekNow', baseUrl: 'https://api.example.com/v1', modelName: 'gpt-4o', status: 'active' as const, lastSyncedAt: null, lastSyncError: null, modelCount: 0, apiKeyConfigured: true };

describe('AI API 接口', () => {
  it('同步开关默认关；同步失败的原因显示出来；打开开关后同步成功', async () => {
    a.overview.mockResolvedValue({ syncEnabled: false, providers: [provider] });
    a.sync.mockRejectedValueOnce(Object.assign(new Error('模型同步开关是关着的'), { name: 'ApiError' }));
    render(<AiApiPage />);
    expect(await screen.findByText('已关闭')).toBeTruthy();
    fireEvent.click(screen.getByText('同步模型'));
    await waitFor(() => expect(a.sync).toHaveBeenCalledWith(1));
    a.setSwitch.mockResolvedValue({ syncEnabled: true });
    a.overview.mockResolvedValue({ syncEnabled: true, providers: [{ ...provider, modelCount: 3 }] });
    fireEvent.click(screen.getByText('打开模型同步'));
    await waitFor(() => expect(a.setSwitch).toHaveBeenCalledWith(true));
    a.sync.mockResolvedValue({ synced: 3 });
    fireEvent.click(await screen.findByText('同步模型'));
    expect(await screen.findByText('「GeekNow」已同步 3 个模型')).toBeTruthy();
  });
  it('添加服务商：地址和 Key 必填；保存后密钥框清空', async () => {
    a.overview.mockResolvedValue({ syncEnabled: false, providers: [] });
    a.create.mockResolvedValue({ id: 2 });
    render(<AiApiPage />);
    fireEvent.click(await screen.findByText('添加服务商'));
    const dlg = await screen.findByRole('dialog', { name: 'AI 服务商' });
    fireEvent.click(within(dlg).getByText('保存'));
    expect(await within(dlg).findByText('请填写服务商名称')).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText(/^名称/), { target: { value: 'OpenAI' } });
    fireEvent.change(within(dlg).getByLabelText(/^接口地址/), { target: { value: 'ftp://x' } });
    fireEvent.click(within(dlg).getByText('保存'));
    expect(await within(dlg).findByText(/要以 https:\/\//)).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText(/^接口地址/), { target: { value: 'https://api.openai.com/v1' } });
    fireEvent.click(within(dlg).getByText('保存'));
    expect(await within(dlg).findByText('请填写 API Key')).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText(/^API Key/), { target: { value: 'sk-1' } });
    fireEvent.click(within(dlg).getByText('保存'));
    await waitFor(() => expect(a.create).toHaveBeenCalledWith({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', modelName: undefined, status: 'active' }));
  });
});

describe('OCR 设置', () => {
  it('选服务商后才能选模型；保存；选“不指定”改回接口设置', async () => {
    a.defaults.mockResolvedValue({
      scopes: [{ key: 'business_license_recognition', label: '营业执照识别', current: null }, { key: 'express_price_recognition', label: '快递价格表识别', current: { providerId: 1, modelId: 'gpt-4o' } }],
      providers: [{ id: 1, name: 'GeekNow', status: 'active', models: ['gpt-4o', 'gpt-4o-mini'] }],
    });
    a.setDefault.mockResolvedValue({ ok: true });
    render(<OcrSettingsPage />);
    const card = await screen.findByRole('group', { name: '营业执照识别' });
    fireEvent.change(within(card).getByLabelText('AI 服务商'), { target: { value: '1' } });
    fireEvent.change(within(card).getByLabelText('模型'), { target: { value: 'gpt-4o-mini' } });
    fireEvent.click(within(card).getByText('保存'));
    await waitFor(() => expect(a.setDefault).toHaveBeenCalledWith('business_license_recognition', 1, 'gpt-4o-mini'));
    const express = screen.getByRole('group', { name: '快递价格表识别' });
    fireEvent.change(within(express).getByLabelText('AI 服务商'), { target: { value: '' } });
    fireEvent.click(within(express).getByText('保存'));
    await waitFor(() => expect(a.setDefault).toHaveBeenCalledWith('express_price_recognition', null, undefined));
  });
});
