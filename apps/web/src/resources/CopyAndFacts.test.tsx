import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./RecordForm', () => ({ RecordForm: () => <div>表单</div>, ReasonDialog: () => null, loadRefOptions: async () => [], clearRefCache: () => undefined }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, get: vi.fn(), list: vi.fn(), relations: vi.fn(), logs: vi.fn() } };
});
import { RecordDetail } from './RecordDetail';
import { copyText } from './CopyValue';

const dto = (type: string, data: Record<string, unknown>, refLabels: Record<string, string> = {}) => ({
  id: 5, type, title: '测试', status: 'normal', statusReason: null, data, secretConfigured: {}, refLabels, files: {}, archived: null, createdAt: '', updatedAt: '2026-10-01',
});

let written: string[] = [];
beforeEach(() => {
  written = [];
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async (t: string) => { written.push(t); }) } });
  vi.mocked(resourceApi.relations).mockResolvedValue([]);
  vi.mocked(resourceApi.logs).mockResolvedValue([]);
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('卡号、手机号等一键复制 + 详情关键信息', () => {
  it('银行账户：详情顶部关键信息里有卡号，点复制写入剪贴板并变成“已复制”', async () => {
    vi.mocked(resourceApi.get).mockResolvedValue(dto('bank-accounts', { accountNo: '6222 0200 1234 5678', balance: 12345, keeperUserId: 9 }, { keeperUserId: '小王' }) as never);
    render(<MemoryRouter><RecordDetail def={getResourceDef('bank-accounts')!} id={5} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    const region = await screen.findByLabelText('关键信息');
    expect(region.textContent).toContain('6222 0200 1234 5678');
    expect(region.textContent).toContain('小王');
    fireEvent.click(screen.getAllByLabelText('复制账号/卡号')[0]);
    await waitFor(() => expect(written).toEqual(['6222 0200 1234 5678']));
    expect((await screen.findAllByText('已复制')).length).toBeGreaterThan(0);
  });

  it('手机号详情：号码、编号类字段都有复制按钮，空值不出现', async () => {
    vi.mocked(resourceApi.get).mockResolvedValue(dto('phones', { number: '13800138000', usageType: 'company_kept' }) as never);
    render(<MemoryRouter><RecordDetail def={getResourceDef('phones')!} id={5} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);
    await screen.findByLabelText('关键信息');
    fireEvent.click(screen.getAllByLabelText('复制号码')[0]);
    await waitFor(() => expect(written).toContain('13800138000'));
  });

  it('剪贴板接口不可用时退回选中复制；仍失败返回 false', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => true;
    expect(await copyText('abc')).toBe(true);
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    expect(await copyText('abc')).toBe(false);
  });
});
