import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';
import { RefSelect, clearRefCache } from './ResourceReferenceControls';
import { resourceApi, type ListResult, type ResourceDto } from './api';

const auth = vi.hoisted(() => ({ companyId: 1, id: 1 }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: auth }) }));
vi.mock('./api', () => ({ resourceApi: { list: vi.fn() } }));
const fields = FINANCE_RESOURCE_DEFS.find(def => def.key === 'finance-labor-costs')!.fields;
const workType = fields.find(field => field.key === 'workTypeId')!;
const unit = fields.find(field => field.key === 'unitId')!;
const row = (id: number, title: string, data = {}, status = 'active'): ResourceDto => ({ id, title, data, status, type: '', statusReason: null, refLabels: {}, files: {}, secretConfigured: {}, createdAt: '', updatedAt: '' });
const list = (items: ResourceDto[], total = items.length): ListResult => ({ items, total, page: 1, pageSize: 200 });
beforeEach(() => { vi.resetAllMocks(); auth.companyId = 1; clearRefCache(); });
afterEach(cleanup);

describe('完整原生字典下拉', () => {
  it('超过200项仍完整读取；按维护顺序/名称排序，分类显示编码，无额外搜索框', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => row(index + 1, `合成分类${index}`, { code: `C${index}`, sortOrder: index === 200 ? -10 : index }));
    vi.mocked(resourceApi.list).mockImplementation(async (_type, query) => list(rows.slice(((query.page ?? 1) - 1) * 200, (query.page ?? 1) * 200), 201));
    const change = vi.fn();
    render(<RefSelect field={workType} value={null} onChange={change}/>);
    await screen.findByRole('option', { name: '合成分类200（C200）' });
    expect(screen.getAllByRole('option')).toHaveLength(202);
    expect(screen.getAllByRole('option')[1].textContent).toBe('合成分类200（C200）');
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: '工作分类' }), { target: { value: '201' } });
    expect(change).toHaveBeenCalledWith(201);
    expect(resourceApi.list).toHaveBeenCalledWith(workType.ref, { page: 2, pageSize: 200, showHidden: true });
  });

  it('计价单位只显示名称，停用不新列；当前历史选择不在目录时仍保留', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue(list([row(1, '元/件', { code: 'YJ' }), row(2, '停用单位', {}, 'inactive')]));
    render(<RefSelect field={unit} value={9} labelNow="原有计价单位" onChange={vi.fn()}/>);
    await screen.findByRole('option', { name: '元/件' });
    expect(screen.queryByRole('option', { name: /YJ|停用单位/ })).toBeNull();
    expect(screen.getByRole('option', { name: '原有计价单位' })).toHaveProperty('selected', true);
    expect(screen.getByRole('option', { name: '请选择计价单位' })).toBeTruthy();
  });

  it('加载失败保留原选择且可以重试；字典变更使完整选项重新读取', async () => {
    vi.mocked(resourceApi.list).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(list([row(10, '重试单位')])).mockResolvedValueOnce(list([row(10, '改名后的单位')]));
    render(<RefSelect field={unit} value={9} labelNow="历史单位" onChange={vi.fn()}/>);
    await screen.findByRole('alert');
    expect(screen.getByRole('option', { name: '历史单位' })).toHaveProperty('selected', true);
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    await screen.findByRole('option', { name: '重试单位' });
    act(() => { clearRefCache(unit.ref); });
    expect(screen.queryByRole('option', { name: '重试单位' })).toBeNull();
    await screen.findByRole('option', { name: '改名后的单位' });
  });

  it('切公司后旧首屏响应不会继续分页或混入新目录', async () => {
    let finish!: (result: ListResult) => void;
    vi.mocked(resourceApi.list).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(list([row(500, '新公司单位')]));
    const view = render(<RefSelect field={unit} value={null} onChange={vi.fn()}/>);
    await waitFor(() => expect(resourceApi.list).toHaveBeenCalledTimes(1));
    auth.companyId = 2; view.rerender(<RefSelect field={unit} value={null} onChange={vi.fn()}/>);
    await screen.findByRole('option', { name: '新公司单位' });
    await act(async () => { finish(list(Array.from({ length: 200 }, (_, index) => row(index + 1, '旧公司单位')), 201)); });
    expect(resourceApi.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('option', { name: '旧公司单位' })).toBeNull();
  });
});
