import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerifyDialog } from './BaseCodeDialogs';
import { JstUploadPage } from './JstUploadPage';
import { jstApi, type BaseCodeReport } from './jstApi';

vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../../../resources/RecordDetail', () => ({ RecordDetail: () => <div>商品档案抽屉</div>, useResourceCan: () => () => true }));
vi.mock('./jstApi', async (orig) => {
  const real = await orig<typeof import('./jstApi')>();
  return { ...real, jstApi: { baseReport: vi.fn(), baseVerify: vi.fn(), uploadOptions: vi.fn(), uploadCheck: vi.fn(), upload: vi.fn(), uploadLogs: vi.fn() } };
});
const m = vi.mocked(jstApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const report = (over: Partial<BaseCodeReport>): BaseCodeReport => ({
  id: 1, code: 'SG-PG-HFS-1KG', name: '红富士', status: 'pending', aliasOf: null, signature: 'sig1', issues: [], issueCount: 0, secondVerification: false, baselineMissing: false, changes: [],
  outbound: { labels: { sku_id: '商品编码', weight: '重量(kg)' }, values: { sku_id: 'SG-PG-HFS-1KG', weight: 1 } }, uploadSignature: 'up1', uploadedCode: null, replacing: false, jstStatus: 'not_synced', ...over,
});

describe('核对并验证基础编码', () => {
  it('有资料问题的不能验证并给出“去修改”；勾选已核对后才能验证，验证带着核对时的指纹', async () => {
    m.baseReport.mockImplementation(async (id) => (id === 1 ? report({}) : report({ id: 2, code: 'BAD', signature: 'sig2', issueCount: 1, issues: [{ archiveKey: 'product:9', productId: 9, archiveName: '无重量苹果', parentPath: ['苹果礼盒'], messages: ['重量必须大于 0（克）'] }] })));
    m.baseVerify.mockResolvedValue({ results: [{ id: 1, ok: true }], verified: 1, failed: 0 });
    render(<VerifyDialog ids={[1, 2]} isAdmin onClose={() => undefined} onDone={() => undefined} />);
    await screen.findAllByText('SG-PG-HFS-1KG');
    const btn = await screen.findByRole('button', { name: '验证 1 条' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '下一条' }));
    await screen.findByText(/还有 1 个资料问题/);
    fireEvent.click(screen.getByRole('button', { name: '去修改' }));
    expect(await screen.findByText('商品档案抽屉')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/我已核对以上 1 条/));
    expect((screen.getByRole('button', { name: '验证 1 条' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '验证 1 条' }));
    await waitFor(() => expect(m.baseVerify).toHaveBeenCalledWith([{ id: 1, signature: 'sig1', uploadSignature: 'up1' }], true, false, false));
  });

  it('二次验证列出前后差异；改码要先确认旧码已处理才能同步', async () => {
    m.baseReport.mockResolvedValue(report({ status: 'reverify', secondVerification: true, replacing: true, uploadedCode: 'OLD', changes: [{ source: '红富士', field: 'purchasePrice', label: '采购价', before: 1000, after: 1300 }] }));
    render(<VerifyDialog ids={[1]} isAdmin onClose={() => undefined} onDone={() => undefined} />);
    await screen.findByText('采购价');
    fireEvent.click(screen.getByLabelText(/我已核对/));
    fireEvent.click(screen.getByLabelText(/加入聚水潭同步队列/));
    const go = screen.getByRole('button', { name: '验证 1 条' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/确认禁用旧编码并创建新编码/));
    expect(go.disabled).toBe(false);
  });
});

describe('资料维护 · 商品资料上传', () => {
  it('必填项没填完不能提交；编码重复是高风险，不让传', async () => {
    m.uploadOptions.mockResolvedValue({ categories: ['水果/苹果类'], brands: [] });
    m.uploadLogs.mockResolvedValue({ total: 0, rows: [] });
    m.uploadCheck.mockResolvedValue({ hasHighRisk: true, hasWarning: false, matches: [{ source: '聚水潭普通商品', field: 'skuId', level: 'high', hit: 'SKU1' }] });
    render(<JstUploadPage />);
    const submit = await screen.findByRole('button', { name: '加入同步队列' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/还需填写：商品编码/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^商品编码（必填）/), { target: { value: 'SKU1' } });
    fireEvent.click(screen.getByRole('button', { name: '检查是否重复' }));
    await screen.findByText(/【不能上传】/);
  });
});
