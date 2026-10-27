import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { settingsApi } from '../../resources/api';
import { financeApi } from '../finance/financeApi';
import { ApiKeysPage } from '../finance/DataToolPages';
import { AuditPage } from './AuditPage';
import { IntegrationsPage } from './IntegrationsPage';

vi.mock('../../api/client', async (orig) => ({ ...(await orig<typeof import('../../api/client')>()), api: vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../../resources/api', async (orig) => {
  const mod = await orig<typeof import('../../resources/api')>();
  return { ...mod, settingsApi: { overview: vi.fn(), saveQiniu: vi.fn(), saveVision: vi.fn(), testQiniu: vi.fn(), testVision: vi.fn() } };
});
vi.mock('../../resources/RecordForm', async (orig) => ({ ...(await orig<typeof import('../../resources/RecordForm')>()), loadRefOptions: vi.fn().mockResolvedValue([{ value: 3, label: '王会计' }]) }));
vi.mock('../finance/financeApi', async (orig) => {
  const mod = await orig<typeof import('../finance/financeApi')>();
  return { ...mod, financeApi: { ...mod.financeApi, apiKeys: vi.fn(), revokeApiKey: vi.fn() } };
});
const apiMock = vi.mocked(api);

const overview = {
  zones: [{ value: 'z0', label: '华东' }],
  qiniu: { configured: true, accessKey: 'AK', secretKeyConfigured: true, bucket: 'b', zone: 'z0', domain: 'https://cdn.x.com', isPrivate: true },
  vision: { configured: false, baseUrl: '', apiKeyConfigured: false, model: '', enabled: false },
};

beforeEach(() => { vi.mocked(settingsApi.overview).mockResolvedValue(overview as never); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('接口设置', () => {
  it('没改东西时保存和测试按钮的状态：保存不可点；改了才出现“有未保存的修改”，并要求先保存再测试', async () => {
    render(<IntegrationsPage />);
    const card = await screen.findByRole('form', { name: '七牛云存储' });
    expect((within(card).getByText('保存') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText('空间名（Bucket）'), { target: { value: 'b2' } });
    expect(within(card).getByText('有未保存的修改')).toBeTruthy();
    expect((within(card).getByText('测试连接') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByText('放弃修改'));
    expect((within(card).getByLabelText('空间名（Bucket）') as HTMLInputElement).value).toBe('b');
  });
  it('外链域名、接口地址必须是 https 地址，不合格不发请求', async () => {
    render(<IntegrationsPage />);
    const card = await screen.findByRole('form', { name: '七牛云存储' });
    fireEvent.change(within(card).getByLabelText(/外链域名/), { target: { value: 'cdn.x.com' } });
    expect(within(card).getAllByText(/要以 https:\/\/ 开头/).length).toBeGreaterThan(0);
    fireEvent.click(within(card).getByText('保存'));
    expect(settingsApi.saveQiniu).not.toHaveBeenCalled();
  });
  it('密钥输入框默认遮住，点“显示”才看得到', async () => {
    render(<IntegrationsPage />);
    const card = await screen.findByRole('form', { name: '识别大模型' });
    const key = within(card).getByLabelText('API Key') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.click(within(card).getByRole('button', { name: '显示内容' }));
    expect(key.type).toBe('text');
  });
});

describe('API 密钥', () => {
  const rows = [
    { id: 'abcdef1234567890', name: '对账程序', scope: 'verified_bundle_read', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null },
    { id: 'zzzz0000111122223', name: '旧密钥', scope: 'company_catalog_read', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, revokedAt: '2026-01-02T00:00:00Z' },
  ];
  beforeEach(() => { vi.mocked(financeApi.apiKeys).mockResolvedValue(rows as never); vi.mocked(financeApi.revokeApiKey).mockResolvedValue({ ok: true }); });
  it('默认只列有效密钥，可切换看已撤销；只显示编号尾巴；调用说明可展开', async () => {
    render(<ApiKeysPage />);
    expect(await screen.findByText('对账程序')).toBeTruthy();
    expect(screen.queryByText('旧密钥')).toBeNull();
    expect(screen.getByText('有效密钥 1 个')).toBeTruthy();
    expect(screen.getByText('••••34567890')).toBeTruthy();
    fireEvent.click(screen.getByText(/查看已撤销（1）/));
    expect(screen.getByText('旧密钥')).toBeTruthy();
    fireEvent.click(screen.getByText('查看调用说明'));
    expect(screen.getByLabelText('调用说明').textContent).toContain('verified-bundles');
  });
  it('撤销要在弹窗里二次确认', async () => {
    render(<ApiKeysPage />);
    fireEvent.click(await screen.findByText('撤销'));
    expect(financeApi.revokeApiKey).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog', { name: '撤销密钥' })).getByText('确认撤销'));
    await waitFor(() => expect(financeApi.revokeApiKey).toHaveBeenCalledWith('abcdef1234567890'));
  });
  it('新建密钥后只显示一次，复制失败时提示手动复制', async () => {
    apiMock.mockResolvedValue({ id: 'n1', name: '新程序', key: 'sk_secret_value' } as never);
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) } });
    render(<ApiKeysPage />);
    await screen.findByText('对账程序');
    fireEvent.change(screen.getByLabelText('用途名称'), { target: { value: '新程序' } });
    fireEvent.click(screen.getByText('创建密钥'));
    const box = (await screen.findByLabelText('新建 API 密钥')) as HTMLInputElement;
    expect(box.value).toBe('sk_secret_value');
    fireEvent.click(screen.getByText('复制密钥'));
    expect(await screen.findByText(/复制失败，请手动/)).toBeTruthy();
  });
});

describe('审计日志', () => {
  const page = { total: 1, page: 1, size: 20, items: [{ source: 'system', id: '1', at: '2026-01-01T00:00:00Z', actorName: '王会计', actorId: 3, action: 'login', resourceType: 'auth', resourceId: null, detail: { ip: '1.1.1.1' } }] };
  beforeEach(() => { apiMock.mockResolvedValue(page as never); });
  it('可按操作人筛选，请求带上 actorId；没有结果时能清除筛选', async () => {
    render(<AuditPage />);
    await screen.findByText('login');
    fireEvent.change(screen.getByLabelText('操作人'), { target: { value: '3' } });
    await waitFor(() => expect(apiMock).toHaveBeenLastCalledWith(expect.stringContaining('actorId=3')));
    apiMock.mockResolvedValue({ ...page, total: 0, items: [] } as never);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'zzz' } });
    fireEvent.click(await screen.findByText('清除筛选，查看全部'));
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
  });
  it('点详情展开，可复制详情', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AuditPage />);
    fireEvent.click(await screen.findByText('详情'));
    expect(screen.getByText(/1\.1\.1\.1/)).toBeTruthy();
    fireEvent.click(screen.getByText('复制详情'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByText('详情已复制')).toBeTruthy();
  });
});
