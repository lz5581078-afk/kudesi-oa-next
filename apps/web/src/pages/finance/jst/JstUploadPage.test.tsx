import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JstUploadPage } from './JstUploadPage';
import { jstApi } from './jstApi';
const auth = vi.hoisted(() => ({ user: { id: 1, companyId: 1, permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } } }));
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ ...auth, can: () => true }) }));
vi.mock('./jstApi', () => ({ jstApi: { uploadLogs: vi.fn(), uploadOptions: vi.fn(), uploadCheck: vi.fn(), upload: vi.fn() } }));
const checked = (over: Partial<Awaited<ReturnType<typeof jstApi.uploadCheck>>> = {}): Awaited<ReturnType<typeof jstApi.uploadCheck>> => ({ signature: 'signed-current-result', hasHighRisk: false, hasWarning: false, errors: [], matches: [], ...over });
const hit = { source: '聚水潭实时', field: 'skuId', level: 'high' as const, hit: '原商品', skuId: 'OLD-SKU', styleId: 'OLD-STYLE', name: '原商品', spec: '红色;100g', category: '水果/苹果类' };
const log = { id: 1, skuId: 'SKU001', styleId: 'STYLE001', name: '商品', status: 'queued', message: '等待发送', createdAt: '2026-10-31T01:00:00Z' };
beforeEach(() => {
  auth.user = { id: 1, companyId: 1, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  vi.mocked(jstApi.uploadLogs).mockResolvedValue({ total: 0, rows: [] });
  vi.mocked(jstApi.uploadOptions).mockResolvedValue({ categories: ['水果/苹果类'], brands: [] });
  vi.mocked(jstApi.uploadCheck).mockResolvedValue(checked());
  vi.mocked(jstApi.upload).mockResolvedValue({ id: 10, queued: true, warnings: [] });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); });
async function openFilled() {
  fireEvent.click(screen.getByRole('button', { name: '上传普通商品资料' }));
  const dialog = await screen.findByRole('dialog', { name: '普通商品资料上传' });
  await within(dialog).findByRole('option', { name: '水果/苹果类' });
  fireEvent.click(within(dialog).getByRole('button', { name: '填入测试数据' }));
  return dialog;
}
describe('资料维护原主页及内窗', () => {
  it('三面板、四列表、四条字段对照及30条服务端分页，上传填写只在内窗', async () => {
    vi.mocked(jstApi.uploadLogs).mockResolvedValue({ total: 31, rows: [log] });
    render(<JstUploadPage />);
    const table = await screen.findByRole('table', { name: '商品上传记录' });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent?.replace(/[↕▲▼]/g, ''))).toEqual(['商品编码', '状态', '提示信息', '上传时间']);
    expect(screen.getByText('待发送')).toBeTruthy(); expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(within(screen.getByRole('table', { name: '导入模板字段对照' })).getAllByRole('row')).toHaveLength(5);
    expect(screen.queryByLabelText(/颜色及规格/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(jstApi.uploadLogs).toHaveBeenLastCalledWith({ page: 2, keyword: undefined }));
    expect(screen.getByText('第 2 页，共 31 条')).toBeTruthy();
  });
  it('原记录与模板表保留三态排序及可持久化拖动列宽，不增加本地搜索或分页', async () => {
    vi.mocked(jstApi.uploadLogs).mockResolvedValue({ total: 2, rows: [{ ...log, id: 2, skuId: 'SKU002' }, log] });
    const view = render(<JstUploadPage />);
    const table = await screen.findByRole('table', { name: '商品上传记录' });
    const codes = () => within(table).getAllByRole('row').slice(1).map(row => row.firstElementChild?.textContent);
    expect(codes()).toEqual(['SKU002', 'SKU001']);
    const sort = within(table).getByRole('button', { name: '商品编码' });
    fireEvent.click(sort); expect(codes()).toEqual(['SKU001', 'SKU002']); expect(sort.closest('th')?.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(sort); expect(codes()).toEqual(['SKU002', 'SKU001']); expect(sort.closest('th')?.getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(sort); expect(sort.closest('th')?.getAttribute('aria-sort')).toBe('none');
    const handle = within(table).getByRole('button', { name: '调整商品编码列宽' });
    fireEvent(handle, new MouseEvent('pointerdown', { clientX: 100, bubbles: true }));
    fireEvent(handle, new MouseEvent('pointermove', { clientX: 150, bubbles: true }));
    fireEvent(handle, new MouseEvent('pointerup', { clientX: 150, bubbles: true }));
    expect((table.querySelector('col') as HTMLElement).style.width).toBe('190px');
    expect(screen.getAllByRole('button', { name: '下一页' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '显示字段' })).toBeNull();
    expect(within(screen.getByRole('table', { name: '导入模板字段对照' })).getByRole('button', { name: '调整主要字段列宽' })).toBeTruthy();
    view.unmount(); render(<JstUploadPage />);
    expect(((await screen.findByRole('table', { name: '商品上传记录' })).querySelector('col') as HTMLElement).style.width).toBe('190px');
  });

  it('显式搜索和刷新使用已提交条件，旧查询迟到不能盖过新查询', async () => {
    let late!: (value: Awaited<ReturnType<typeof jstApi.uploadLogs>>) => void;
    vi.mocked(jstApi.uploadLogs).mockImplementation(params => params.keyword === '旧' ? new Promise(resolve => { late = resolve; }) : Promise.resolve({ total: 1, rows: [{ ...log, skuId: params.keyword || '初始' }] }));
    render(<JstUploadPage />); await screen.findByText('初始');
    const input = screen.getByLabelText('搜索上传记录'); fireEvent.change(input, { target: { value: '旧' } }); expect(jstApi.uploadLogs).toHaveBeenCalledTimes(1);
    fireEvent.submit(input.closest('form')!); await waitFor(() => expect(jstApi.uploadLogs).toHaveBeenCalledWith({ keyword: '旧', page: 1 }));
    fireEvent.change(input, { target: { value: '新' } }); fireEvent.submit(input.closest('form')!); await screen.findByText('新');
    late({ total: 1, rows: [{ ...log, skuId: '旧结果' }] });
    fireEvent.change(input, { target: { value: '未搜索' } }); fireEvent.click(screen.getByRole('button', { name: '刷新记录' }));
    await waitFor(() => expect(jstApi.uploadLogs).toHaveBeenLastCalledWith({ keyword: '新', page: 1 })); expect(screen.queryByText('旧结果')).toBeNull();
  });
  it('原生远端分类focus刷新，品牌是自由文字；清空及关闭恢复入口焦点', async () => {
    render(<JstUploadPage />); const entrance = screen.getByRole('button', { name: '上传普通商品资料' }); entrance.focus();
    const dialog = await openFilled();
    expect(within(dialog).getByLabelText(/^品牌/).tagName).toBe('INPUT');
    fireEvent.focus(within(dialog).getByLabelText(/^分类/)); await waitFor(() => expect(jstApi.uploadOptions).toHaveBeenCalledTimes(2));
    fireEvent.click(within(dialog).getByRole('button', { name: '清空' })); expect((within(dialog).getByLabelText(/^商品编码/) as HTMLInputElement).value).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' })); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(entrance);
  });
  it('所有必填校验先于查重，数值0满足必填，成功保留输入与待发送结果', async () => {
    render(<JstUploadPage />); fireEvent.click(screen.getByRole('button', { name: '上传普通商品资料' }));
    fireEvent.click(await screen.findByRole('button', { name: '查重并上传' })); expect(await screen.findByText(/请先填写必填项：商品编码/)).toBeTruthy(); expect(jstApi.uploadCheck).not.toHaveBeenCalled();
    await screen.findByRole('option', { name: '水果/苹果类' }); fireEvent.click(screen.getByRole('button', { name: '填入测试数据' }));
    fireEvent.change(screen.getByLabelText(/^成本价/), { target: { value: '0' } }); fireEvent.change(screen.getByLabelText(/^重量/), { target: { value: '0' } });
    const sku = (screen.getByLabelText(/^商品编码/) as HTMLInputElement).value;
    fireEvent.click(screen.getByRole('button', { name: '查重并上传' })); await screen.findByText('已提交，等待发送。');
    expect(jstApi.upload).toHaveBeenCalledWith(expect.objectContaining({ costPrice: 0, weight: 0, skuId: sku }), 'signed-current-result', false);
    expect((screen.getByLabelText(/^商品编码/) as HTMLInputElement).value).toBe(sku); expect(screen.getByText('上传记录 #10。发送结果请查看上传记录。')).toBeTruthy();
  });
  it('高风险完整六字段结果须显式继续；非身份修改保留核对，改三身份立即失效', async () => {
    vi.mocked(jstApi.uploadCheck).mockResolvedValue(checked({ hasHighRisk: true, matches: [hit] }));
    render(<JstUploadPage />); await openFilled(); fireEvent.click(screen.getByRole('button', { name: '查重并上传' }));
    const duplicate = await screen.findByRole('table', { name: '商品编码重复' }); expect(within(duplicate).getAllByRole('columnheader')).toHaveLength(6); expect(jstApi.upload).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/^品牌/), { target: { value: '核对后品牌' } }); expect(screen.getByRole('region', { name: '上传前查重结果' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '已核对，继续上传' })); await screen.findByText('已提交，等待发送。');
    expect(jstApi.upload).toHaveBeenCalledWith(expect.objectContaining({ brand: '核对后品牌' }), 'signed-current-result', true);
    fireEvent.change(screen.getByLabelText(/^款式编码/), { target: { value: '另一个款式' } }); expect(screen.queryByRole('region', { name: '上传前查重结果' })).toBeNull();
  });
  it('查重失败保留提示但不谎称无重复，未获得签名时不能继续', async () => {
    vi.mocked(jstApi.uploadCheck).mockRejectedValue(new Error('合成查重失败'));
    render(<JstUploadPage />); await openFilled(); fireEvent.click(screen.getByRole('button', { name: '查重并上传' }));
    await screen.findByText('查重失败：合成查重失败'); expect(screen.queryByText('未发现重复资料，可以上传。')).toBeNull();
    expect((screen.getByRole('button', { name: '已核对，继续上传' }) as HTMLButtonElement).disabled).toBe(true); expect(jstApi.upload).not.toHaveBeenCalled();
  });
  it('同名远端叶灰显并说明，测试数据只选可用项，原有效分类仍可提交', async () => {
    const reason = '聚水潭存在同名分类，无法唯一确定该分类，请调整名称后刷新。';
    vi.mocked(jstApi.uploadOptions).mockResolvedValue({ categories: ['甲/梨'], brands: [], categoryOptions: [{ value: '甲/苹果', label: '甲/苹果', disabled: true, reason }, { value: '乙/苹果', label: '乙/苹果', disabled: true, reason }, { value: '甲/梨', label: '甲/梨', disabled: false }] });
    render(<JstUploadPage />); fireEvent.click(screen.getByRole('button', { name: '上传普通商品资料' }));
    const invalid = await screen.findByRole('option', { name: /甲\/苹果（不可选/ }); expect((invalid as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole('option', { name: /乙\/苹果（不可选/ }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByRole('note').textContent).toContain(reason);
    fireEvent.click(screen.getByRole('button', { name: '填入测试数据' })); expect((screen.getByLabelText(/^分类/) as HTMLSelectElement).value).toBe('甲/梨');
    fireEvent.click(screen.getByRole('button', { name: '查重并上传' })); await screen.findByText('已提交，等待发送。');
    expect(jstApi.uploadCheck).toHaveBeenCalledWith(expect.objectContaining({ categoryName: '甲/梨' }));
    expect(jstApi.upload).toHaveBeenCalledWith(expect.objectContaining({ categoryName: '甲/梨' }), 'signed-current-result', false);
  });
  it('已选分类刷新后变为同名禁选，原显式确认也不绕过；没有可用项时测试数据留空', async () => {
    vi.mocked(jstApi.uploadCheck).mockResolvedValue(checked({ hasWarning: true, errors: ['合成核对提示'] }));
    render(<JstUploadPage />); await openFilled(); fireEvent.click(screen.getByRole('button', { name: '查重并上传' })); await screen.findByRole('button', { name: '已核对，继续上传' });
    const reason = '聚水潭存在同名分类，无法唯一确定该分类，请调整名称后刷新。';
    vi.mocked(jstApi.uploadOptions).mockResolvedValue({ categories: [], brands: [], categoryOptions: [{ value: '水果/苹果类', label: '水果/苹果类', disabled: true, reason }] });
    fireEvent.click(screen.getByRole('button', { name: '刷新分类/品牌' })); await screen.findByRole('option', { name: /水果\/苹果类（不可选/ });
    fireEvent.click(screen.getByRole('button', { name: '已核对，继续上传' })); expect((await screen.findByRole('alert')).textContent).toBe(reason); expect(jstApi.upload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '填入测试数据' })); expect((screen.getByLabelText(/^分类/) as HTMLSelectElement).value).toBe('');
  });

  it('三身份编辑后迟到查重不能恢复旧确认或自动提交', async () => {
    let finish!: (value: Awaited<ReturnType<typeof jstApi.uploadCheck>>) => void;
    vi.mocked(jstApi.uploadCheck).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<JstUploadPage />); await openFilled(); fireEvent.click(screen.getByRole('button', { name: '查重并上传' }));
    fireEvent.change(screen.getByLabelText(/^商品名称/), { target: { value: '新名称' } }); finish(checked());
    await waitFor(() => expect(screen.queryByRole('region', { name: '上传前查重结果' })).toBeNull()); expect(jstApi.upload).not.toHaveBeenCalled();
  });
  it('公司、人员或权限切换卸载旧表单，旧上传响应不回填新范围', async () => {
    let finish!: (value: Awaited<ReturnType<typeof jstApi.upload>>) => void;
    vi.mocked(jstApi.upload).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<JstUploadPage />); await openFilled(); fireEvent.click(screen.getByRole('button', { name: '查重并上传' })); await waitFor(() => expect(jstApi.upload).toHaveBeenCalledTimes(1));
    auth.user = { ...auth.user, companyId: 2, id: 2, permissions: { ...auth.user.permissions, allow: ['新权限'] } }; view.rerender(<JstUploadPage />);
    expect(screen.queryByRole('dialog')).toBeNull(); finish({ id: 99, queued: true, warnings: [] });
    await waitFor(() => expect(jstApi.uploadLogs).toHaveBeenCalledTimes(2)); expect(screen.queryByText(/上传记录 #99/)).toBeNull();
  });
});
