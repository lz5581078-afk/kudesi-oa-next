import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { buildCategoryTree, findNode, subtreeIds } from './CategoryTree';
import { LaborCostPage } from './LaborCostPage';
import { CopyVersionDialog } from './CopyVersionDialog';
import { ApiError, api } from '../../../api/client';
import { resetUnitOptionsForTest } from '../../../resources/unitOptions';

vi.mock('../../../api/client', async (orig) => ({ ...(await orig<typeof import('../../../api/client')>()), api: vi.fn() }));
const laborAuth = vi.hoisted(() => ({ companyId: 1, cost: true }));
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: (key: string) => key === 'product.cost.view' ? laborAuth.cost : true, user: { id: 1, companyId: laborAuth.companyId, permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../../../resources/api', async (orig) => {
  const real = await orig<typeof import('../../../resources/api')>();
  return { ...real, resourceApi: { get: vi.fn().mockResolvedValue({ title: '合成归档' }), list: vi.fn(), changeStatus: vi.fn(), update: vi.fn(), remove: vi.fn() } };
});
const m = vi.mocked(resourceApi);
beforeEach(() => { laborAuth.companyId = 1; laborAuth.cost = true; resetUnitOptionsForTest({}); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const dto = (id: number, type: string, title: string, data: Record<string, unknown>, status = 'active', refLabels: Record<string, string> = {}): ResourceDto =>
  ({ id, type, title, status, statusReason: null, data, secretConfigured: {}, refLabels, files: {}, createdAt: '', updatedAt: '' });

describe('归档分类树', () => {
  it('按上下级组织，数量含下级；选上级能拿到整棵子树', () => {
    const cats = [dto(1, 'c', '包装车间', {}), dto(2, 'c', '礼盒', { parentId: 1 }), dto(3, 'c', '大礼盒', { parentId: 2 }), dto(4, 'c', '仓库', {})];
    const tree = buildCategoryTree(cats, [3, 3, 4, null]);
    expect(tree.map((n) => [n.name, n.count])).toEqual([['包装车间', 2], ['仓库', 1]]);
    expect(subtreeIds(findNode(tree, 1)!)).toEqual([1, 2, 3]);
  });
});

describe('人力成本表页面', () => {
  it('默认打开默认版本；按归档分类筛项目；备注不混入确认原因；草稿版本可以启用', async () => {
    const versions = [dto(1, 'v', '2026春', { versionCode: 'A', isDefault: true }, 'active'), dto(2, 'v', '2026秋', { versionCode: 'B' }, 'draft')];
    const cats = [dto(10, 'c', '包装', {}), dto(11, 'c', '分拣', {})];
    const items = [
      dto(100, 'i', '包装/装盒', { workCode: 'RL-A-BZ-BZ-ZH', workName: '装盒', unitPrice: 150, archiveCategoryId: 10, note: '合成复制备注' }, 'active', { archiveCategoryId: '包装', workTypeId: '包装', unitId: '元/个' }),
      dto(101, 'i', '分拣/挑果', { workCode: 'RL-A-FJ-FJ-TG', workName: '挑果', unitPrice: 0, zeroReason: '外包赠送', archiveCategoryId: 11 }, 'active', { archiveCategoryId: '分拣', workTypeId: '分拣', unitId: '元/个' }),
    ];
    m.list.mockImplementation(async (type) => {
      const pick = type === 'finance-labor-versions' ? versions : type === 'finance-labor-categories' ? cats : type === 'finance-labor-costs' ? items : [];
      return { items: pick, total: pick.length, page: 1, pageSize: 200 };
    });
    m.changeStatus.mockResolvedValue(versions[1]);
    render(<LaborCostPage />);
    await screen.findByText('RL-A-BZ-BZ-ZH');
    expect(screen.queryByText('外包赠送')).toBeNull();
    expect(screen.getByText('¥1.5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^分拣 /  }));
    expect(screen.queryByText('RL-A-BZ-BZ-ZH')).toBeNull();
    expect(screen.getByText('RL-A-FJ-FJ-TG')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^2026秋|^合成第二版本/ }));
    fireEvent.click(await screen.findByRole('button', { name: '启用版本' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '请确认操作' })).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(m.changeStatus).toHaveBeenCalledWith('finance-labor-versions', 2, 'active'));
  });
});

describe('复制版本', () => {
  it('填新编号后调用复制接口，并切到新版本', async () => {
    const versions = [dto(1, 'v', '2026春', { versionCode: 'A', isDefault: true }, 'active')];
    m.list.mockImplementation(async (type) => {
      const pick = type === 'finance-labor-versions' ? versions : [];
      return { items: pick, total: pick.length, page: 1, pageSize: 200 };
    });
    vi.mocked(api).mockResolvedValue({ id: 9 } as never);
    render(<LaborCostPage />);
    fireEvent.click(await screen.findByRole('button', { name: '复制版本' }));
    fireEvent.change(screen.getByLabelText('版本编号'), { target: { value: 'B2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存版本' }));
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith('/finance/labor/versions/1/copy', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ versionCode: 'B2' }) })));
    await screen.findByText(/已复制/);
  });
});

describe('复制新增工作项目', () => {
  it('复制停用零价项目保留备注和单价，清除原原因并恢复启用，必须重新确认零价', async () => {
    const versions = [dto(1, 'v', '合成当前版', { versionCode: 'A', isDefault: true })];
    const item = dto(92, 'i', '合成赠送项目', { versionId: 1, archiveCategoryId: 10, workTypeId: 2, unitId: 3, workCode: 'ZERO-COPY', workName: '合成赠送项目', unitPrice: 0, zeroReason: '原项目赠送原因', note: '需保留的合成备注' }, 'inactive');
    m.list.mockImplementation(async type => { const items = type === 'finance-labor-versions' ? versions : type === 'finance-labor-costs' ? [item] : []; return { items, total: items.length, page: 1, pageSize: 200 }; });
    render(<LaborCostPage/>);
    fireEvent.click(await screen.findByRole('button', { name: '复制新增' }));
    expect(screen.getByRole('textbox', { name: '零人力成本原因' })).toHaveProperty('value', '');
    expect(screen.getByRole('spinbutton', { name: /单位人力成本/ })).toHaveProperty('value', '0');
    expect(screen.getByRole('switch', { name: '状态' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByDisplayValue('需保留的合成备注')).toBeTruthy();
    expect(screen.queryByText(/已确认：/)).toBeNull();
    expect(screen.getByRole('button', { name: '确认该项为0' })).toHaveProperty('disabled', true);
  });
  it('带出原项目的分类、单位和名称，但不带工作编号；没有结果时可清除搜索', async () => {
    const versions = [dto(1, 'v', '2026春', { versionCode: 'A', isDefault: true }, 'active')];
    const items = [dto(100, 'i', '包装/装盒', { workCode: 'RL-A-BZ-BZ-ZH', workName: '装盒', unitPrice: 150, archiveCategoryId: 10, note: '合成复制备注' }, 'active', { archiveCategoryId: '包装', workTypeId: '包装', unitId: '元/个' })];
    m.list.mockImplementation(async (type) => {
      const pick = type === 'finance-labor-versions' ? versions : type === 'finance-labor-costs' ? items : [];
      return { items: pick, total: pick.length, page: 1, pageSize: 200 };
    });
    render(<LaborCostPage />);
    await screen.findByText('RL-A-BZ-BZ-ZH');
    fireEvent.click(screen.getByRole('button', { name: '复制新增' }));
    await screen.findByDisplayValue('装盒');
    expect(screen.getByDisplayValue('合成复制备注')).toBeTruthy();
    expect(screen.queryByDisplayValue('RL-A-BZ-BZ-ZH')).toBeNull();
    fireEvent.change(screen.getByLabelText('搜索工作项目'), { target: { value: '不存在' } });
    fireEvent.change(screen.getByLabelText('搜索工作项目'), { target: { value: '' } });
    expect((screen.getByLabelText('搜索工作项目') as HTMLInputElement).value).toBe('');
    await screen.findByText('RL-A-BZ-BZ-ZH');
  });
});

describe('人力成本原版目录与查询行为', () => {
  it('没有版本、没有分类和没有项目分别显示原提示；只有选到末级才显示新增', async () => {
    m.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
    const empty = render(<LaborCostPage/>);
    await screen.findByText('尚无成本版本');
    expect(screen.getByText('请先选择成本版本')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    empty.unmount();
    const versions = [dto(1, 'v', '合成空版', { versionCode: 'EMPTY', isDefault: true })];
    let categories: ResourceDto[] = [];
    m.list.mockImplementation(async type => { const items = type === 'finance-labor-versions' ? versions : type === 'finance-labor-categories' ? categories : []; return { items, total: items.length, page: 1, pageSize: 200 }; });
    const view = render(<LaborCostPage/>);
    await screen.findByText('暂未建立归档分类');
    expect(screen.getByText('请先在左侧管理当前版本的项目归档分类。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新增工作项目' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    view.unmount(); categories = [dto(10, 'c', '合成末级', {})];
    render(<LaborCostPage/>); await screen.findByRole('button', { name: /^合成末级 / });
    expect(screen.getByText('请选择左侧最末级归档分类后新增项目。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新增工作项目' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^合成末级 / }));
    expect(screen.getByRole('button', { name: '新增工作项目' })).toBeTruthy();
    expect(screen.getByText('当前归档分类暂无工作项目')).toBeTruthy();
  });
  const response = (items: ResourceDto[], total = items.length) => ({ items, total, page: 1, pageSize: 200 });
  const version = dto(1, 'finance-labor-versions', '合成当前版本', { versionCode: 'A', isDefault: true });
  it('确认操作等待期间切公司，旧操作响应不能切回旧版本', async () => {
    let finish!: (row: ResourceDto) => void;
    const versions = [version, dto(2, 'v', '甲公司草稿', { versionCode: 'B' }, 'draft')];
    m.list.mockImplementation(async type => response(type === 'finance-labor-versions' ? laborAuth.companyId === 1 ? versions : [dto(9, 'v', '乙公司版本', { versionCode: 'C', isDefault: true })] : type === 'finance-labor-costs' ? [dto(100, 'i', '合成项目', { workCode: `COMPANY-${laborAuth.companyId}`, workName: '合成项目', unitPrice: 100 })] : []));
    m.changeStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<LaborCostPage/>); await screen.findByText('COMPANY-1');
    fireEvent.click(screen.getByRole('button', { name: '启用版本' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '请确认操作' })).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(finish).toBeTruthy());
    laborAuth.companyId = 2; view.rerender(<LaborCostPage/>); await screen.findByText('COMPANY-2');
    await act(async () => finish(versions[1]));
    expect(screen.getByRole('button', { name: /^乙公司版本 / }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('COMPANY-2')).toBeTruthy(); expect(screen.queryByText('COMPANY-1')).toBeNull();
  });
  it('删除项目只作文字确认，引用失败保留资料和窗口，重试成功后刷新', async () => {
    let exists = true, fail = true;
    const v = dto(2, 'v', '合成草稿', { versionCode: 'B' }, 'draft');
    const item = dto(91, 'i', '合成待删除', { workCode: 'DELETE-CHECK', workName: '合成待删除', unitPrice: 100 });
    m.list.mockImplementation(async type => response(type === 'finance-labor-versions' ? [v] : type === 'finance-labor-costs' && exists ? [item] : []));
    m.remove.mockImplementation(async () => { if (fail) { fail = false; throw new ApiError(409, '合成被引用不能删除'); } exists = false; return { ok: true }; });
    render(<LaborCostPage/>); await screen.findByText('DELETE-CHECK');
    fireEvent.click(within(screen.getByRole('region', { name: '工作项目' })).getByRole('button', { name: '删除' }));
    const confirm = screen.getByRole('dialog', { name: '请确认操作' });
    expect(within(confirm).queryByRole('textbox')).toBeNull(); expect(m.remove).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: '确认' }));
    await screen.findByText('合成被引用不能删除'); expect(screen.getByText('DELETE-CHECK')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '请确认操作' })).toBeNull());
    await waitFor(() => expect(screen.queryByText('DELETE-CHECK')).toBeNull());
    expect(m.remove).toHaveBeenLastCalledWith('finance-labor-costs', 91, '人力成本表确认删除项目');
  });
  it('启用先文字确认，取消不写入；确认后选中该版本并读取其项目', async () => {
    const versions = [version, dto(2, 'v', '合成待启用', { versionCode: 'B' }, 'draft')];
    m.list.mockImplementation(async (type, query) => {
      const items = type === 'finance-labor-versions' ? versions : type === 'finance-labor-costs' ? [dto(100 + Number(query.fieldValue), 'i', '合成项目', { workCode: `VERSION-${query.fieldValue}`, workName: '合成项目', unitPrice: 100 })] : [];
      return response(items);
    });
    m.changeStatus.mockImplementation(async () => { versions[0] = { ...version, data: { ...version.data, isDefault: false } }; versions[1] = { ...versions[1], status: 'active', data: { ...versions[1].data, isDefault: true } }; return versions[1]; });
    render(<LaborCostPage/>);
    await screen.findByText('VERSION-1');
    fireEvent.click(screen.getByRole('button', { name: '启用版本' }));
    let confirm = screen.getByRole('dialog', { name: '请确认操作' });
    expect(within(confirm).queryByRole('textbox')).toBeNull(); expect(m.changeStatus).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' })); expect(m.changeStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '启用版本' })); confirm = screen.getByRole('dialog', { name: '请确认操作' });
    fireEvent.click(within(confirm).getByRole('button', { name: '确认' }));
    await screen.findByText('VERSION-2');
    expect(m.changeStatus).toHaveBeenCalledWith('finance-labor-versions', 2, 'active');
    expect(screen.getByRole('button', { name: /^合成待启用 / }).getAttribute('aria-pressed')).toBe('true');
  });
  it('检索只使用原版六类内容，不额外混入组合标题或零价原因', async () => {
    const item = dto(92, 'i', '额外组合标题', { workCode: 'SIX-FIELDS', workName: '合成工作', unitPrice: 0, zeroReason: '仅零值原因', note: '原版备注' });
    m.list.mockImplementation(async type => response(type === 'finance-labor-versions' ? [version] : type === 'finance-labor-costs' ? [item] : []));
    render(<LaborCostPage/>); await screen.findByText('SIX-FIELDS');
    for (const keyword of ['额外组合标题', '仅零值原因']) {
      fireEvent.change(screen.getByLabelText('搜索工作项目'), { target: { value: keyword } });
      expect(screen.queryByText('SIX-FIELDS')).toBeNull();
    }
    fireEvent.change(screen.getByLabelText('搜索工作项目'), { target: { value: '原版备注' } });
    expect(screen.getByText('SIX-FIELDS')).toBeTruthy();
  });
  it('摘要使用默认版本期间，完整显示超过20项，缺失的版本数量不伪造0', async () => {
    const items = Array.from({ length: 25 }, (_, i) => dto(100 + i, 'i', `合成项目${i}`, { workCode: `ALL-${i}`, workName: `工作${i}`, unitPrice: 100 }, i === 24 ? 'inactive' : 'active'));
    const versions = [{ ...version, data: { ...version.data, effectiveFrom: '2000-01-01', effectiveTo: '2000-12-31', itemCount: 25 } }, dto(2, 'v', '未知数量版本', { versionCode: 'B' }, 'draft')];
    let resolveItems!: (result: ReturnType<typeof response>) => void;
    m.list.mockImplementation(async type => type === 'finance-labor-versions' ? response(versions) : type === 'finance-labor-costs' ? new Promise(resolve => { resolveItems = resolve; }) : response([]));
    render(<LaborCostPage/>);
    const summary = await screen.findByRole('region', { name: '人力成本概览' });
    await waitFor(() => expect(resolveItems).toBeTruthy());
    expect(within(summary).getByText('2000-01-01 至 2000-12-31')).toBeTruthy();
    expect(within(summary).getAllByText('加载中…')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^未知数量版本/ }).textContent).toContain('— 项');
    await act(async () => resolveItems(response(items)));
    expect(screen.getByText('ALL-24')).toBeTruthy();
    expect(within(summary).getByText('25 项')).toBeTruthy();
    expect(within(summary).getByText('24 项')).toBeTruthy();
    expect(screen.queryByLabelText('成本版本')).toBeNull();
    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['工作编码', '工作名称', '项目归档分类', '工作分类', '计价单位', '单位人力成本', '状态', '备注', '操作']);
  });
  it('全部和父级不显示普通新增，默认折叠，点击目录展开并在末级恢复新增；复制入口保留', async () => {
    const categories = [dto(10, 'c', '包装父级', {}), dto(11, 'c', '包装末级', { parentId: 10 })];
    const item = dto(100, 'i', '工作甲', { workCode: 'CODE-LEAF', workName: '装盒', archiveCategoryId: 11, unitPrice: 100 });
    m.list.mockImplementation(async type => response(type === 'finance-labor-versions' ? [version] : type === 'finance-labor-categories' ? categories : type === 'finance-labor-costs' ? [item] : []));
    render(<LaborCostPage/>);
    await screen.findByText('CODE-LEAF');
    expect(screen.queryByRole('button', { name: '新增工作项目' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^包装末级 /  })).toBeNull();
    expect(screen.getByRole('button', { name: '复制新增' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^包装父级/ }));
    expect(screen.queryByRole('button', { name: '新增工作项目' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^包装末级 /  }));
    expect(screen.getByRole('button', { name: '新增工作项目' })).toBeTruthy();
  });
  it('按归档分类、工作分类、单位和备注检索；成本不被两位金额格式截掉，权限变化后隐藏', async () => {
    const items = [dto(100, 'i', '工作甲', { workCode: 'CODE-A', workName: '装盒', unitPrice: 12345.6789, note: '特殊验收备注' }, 'active', { archiveCategoryId: '包装目录', workTypeId: '分拣项目', unitId: '元/袋' }), dto(101, 'i', '工作乙', { workCode: 'CODE-B', workName: '贴纸', unitPrice: 200 }, 'active', { archiveCategoryId: '其他目录', workTypeId: '标签', unitId: '元/张' })];
    m.list.mockImplementation(async type => response(type === 'finance-labor-versions' ? [version] : type === 'finance-labor-costs' ? items : []));
    const { rerender } = render(<LaborCostPage/>);
    await screen.findByText('CODE-A');
    expect(screen.getByText('¥123.456789')).toBeTruthy();
    expect(screen.getByText('特殊验收备注')).toBeTruthy();
    for (const keyword of ['包装目录', '分拣项目', '元/袋', '特殊验收备注']) {
      fireEvent.change(screen.getByLabelText('搜索工作项目'), { target: { value: keyword } });
      expect(screen.getByText('CODE-A')).toBeTruthy(); expect(screen.queryByText('CODE-B')).toBeNull();
    }
    laborAuth.cost = false; rerender(<LaborCostPage/>);
    expect(screen.queryByText('¥123.456789')).toBeNull();
    expect(screen.getByText('无权限')).toBeTruthy();
  });
  it('版本全分页读取，末页的默认版本也能被选中', async () => {
    const versions = Array.from({ length: 201 }, (_, index) => dto(index + 1, 'v', `合成版本${index + 1}`, { versionCode: `V${index}`, isDefault: index === 200 }, index === 200 ? 'active' : 'draft'));
    m.list.mockImplementation(async (type, query) => type === 'finance-labor-versions' ? response(versions.slice(((query.page ?? 1) - 1) * 200, (query.page ?? 1) * 200), 201) : response([]));
    render(<LaborCostPage/>);
    await waitFor(() => expect(screen.getByRole('button', { name: /^合成版本201 / }).getAttribute('aria-pressed')).toBe('true'));
    expect(m.list).toHaveBeenCalledWith('finance-labor-versions', expect.objectContaining({ page: 2, pageSize: 200 }));
  });
  it('切版本清空搜索及旧项目，迟到的上一版本结果不能覆盖当前版本', async () => {
    const versions = [version, dto(2, 'v', '合成第二版本', { versionCode: 'B' }, 'draft')];
    let finishSecond!: (result: ReturnType<typeof response>) => void;
    m.list.mockImplementation(async (type, query) => {
      if (type === 'finance-labor-versions') return response(versions);
      if (type !== 'finance-labor-costs') return response([]);
      if (query.fieldValue === 2) return new Promise(resolve => { finishSecond = resolve; });
      return response([dto(100, 'i', '原项目', { workCode: 'CODE-OLD', workName: '原项目', unitPrice: 100 })]);
    });
    render(<LaborCostPage/>);
    await screen.findByText('CODE-OLD');
    fireEvent.change(screen.getByLabelText('搜索工作项目'), { target: { value: 'OLD' } });
    fireEvent.click(screen.getByRole('button', { name: /^合成第二版本 / }));
    expect((screen.getByLabelText('搜索工作项目') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('CODE-OLD')).toBeNull();
    await waitFor(() => expect(finishSecond).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^合成当前版本/ }));
    await screen.findByText('CODE-OLD');
    await act(async () => { finishSecond(response([dto(200, 'i', '迟到项目', { workCode: 'CODE-WRONG', unitPrice: 100 })])); });
    expect(screen.queryByText('CODE-WRONG')).toBeNull();
    expect(screen.getByText('CODE-OLD')).toBeTruthy();
  });
  it('切公司后旧版本读取不能覆盖新公司的目录', async () => {
    let finishFirst!: (result: ReturnType<typeof response>) => void;
    m.list.mockImplementation(async type => {
      if (type === 'finance-labor-versions') return laborAuth.companyId === 1 ? new Promise(resolve => { finishFirst = resolve; }) : response([dto(2, 'v', '乙公司版本', { versionCode: 'B', isDefault: true })]);
      return response(type === 'finance-labor-costs' ? [dto(200, 'i', '乙公司项目', { workCode: 'COMPANY-B', unitPrice: 100 })] : []);
    });
    const { rerender } = render(<LaborCostPage/>);
    await waitFor(() => expect(finishFirst).toBeTruthy());
    laborAuth.companyId = 2; rerender(<LaborCostPage/>);
    await screen.findByText('COMPANY-B');
    await act(async () => { finishFirst(response([version])); });
    expect(screen.getByRole('button', { name: /^乙公司版本 / }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('COMPANY-B')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^合成当前版本 / })).toBeNull();
  });
  it('刷新版本失败保留已完成资料和错误，不再用项目刷新清掉错误', async () => {
    let reads = 0;
    m.list.mockImplementation(async type => {
      if (type === 'finance-labor-versions') { if (++reads > 1) throw new Error('合成版本刷新失败'); return response([version, dto(2, 'v', '另一个启用版本', { versionCode: 'B' })]); }
      return response(type === 'finance-labor-costs' ? [dto(100, 'i', '保留项目', { workCode: 'KEEP-ROW', unitPrice: 100 })] : []);
    });
    m.update.mockResolvedValue(version);
    render(<LaborCostPage/>);
    await screen.findByText('KEEP-ROW');
    fireEvent.click(screen.getByRole('button', { name: '设为默认版本' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '合成版本刷新失败');
    expect(screen.getByText('KEEP-ROW')).toBeTruthy();
  });
  it('新建版本按原版UTC日期预填RL编号', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T16:30:00Z'));
    m.list.mockResolvedValue(response([]));
    render(<LaborCostPage/>);
    fireEvent.click(screen.getByRole('button', { name: '新建成本版本' }));
    expect((await screen.findByRole('textbox', { name: /^版本编号/ }) as HTMLInputElement).value).toBe('RL-20261103');
  });
});

it('版本资料仅草稿可编辑；启用版项目/分类删除禁用，草稿恢复删除入口', async () => {
  const versions = [dto(1, 'v', '合成启用', { versionCode: 'A', isDefault: true }), dto(2, 'v', '合成草稿', { versionCode: 'B' }, 'draft'), dto(3, 'v', '合成停用', { versionCode: 'C' }, 'inactive')];
  const cats = [dto(10, 'c', '合成根', {}), dto(11, 'c', '合成末级', { parentId: 10 })];
  const items = [dto(91, 'i', '合成项目', { workCode: 'SYNTHETIC-LIFECYCLE', workName: '合成项目', archiveCategoryId: 11, unitPrice: 100 })];
  m.list.mockImplementation(async (type, query) => { const rows = type === 'finance-labor-versions' ? versions : type === 'finance-labor-categories' ? cats : type === 'finance-labor-costs' ? items : []; return { items: rows.map(row => type === 'finance-labor-categories' ? { ...row, data: { ...row.data, versionId: query.fieldValue, referenceCount: row.id === 11 ? 1 : 0 } } : row), total: rows.length, page: 1, pageSize: 200 }; });
  render(<LaborCostPage/>);
  await screen.findByText('SYNTHETIC-LIFECYCLE');
  expect(screen.getAllByRole('button', { name: '编辑版本' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: '删除' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: '管理归档' }));
  const manager = screen.getByRole('dialog', { name: '管理项目归档分类' });
  fireEvent.click(await within(manager).findByRole('button', { name: /^合成根/ }));
  expect(within(manager).getByRole('button', { name: '删除合成末级' })).toHaveProperty('disabled', true);
  fireEvent.click(within(manager).getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: /^合成草稿/ }));
  await screen.findByText('SYNTHETIC-LIFECYCLE');
  expect(screen.getByRole('button', { name: '删除' })).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: /^合成停用/ }));
  await screen.findByText('SYNTHETIC-LIFECYCLE');
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
});

it('复制版本预填原编号-COPY、名称副本、期间/日期/备注，提交时保留并大写输入编号', async () => {
  const source = dto(1, 'finance-labor-versions', '合成春季', { versionCode: 'RL-SPRING', versionName: '合成春季', periodName: '2026春', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', note: '合成版本说明' });
  const copied = vi.fn(); vi.mocked(api).mockResolvedValue({ id: 9 });
  render(<CopyVersionDialog source={source} onClose={vi.fn()} onCopied={copied}/>);
  expect(screen.getByLabelText('版本编号')).toHaveProperty('value', 'RL-SPRING-COPY');
  expect(screen.getByLabelText('版本名称')).toHaveProperty('value', '合成春季 - 副本');
  expect(screen.getByLabelText('期间名称')).toHaveProperty('value', '2026春');
  expect(screen.getByLabelText('生效开始')).toHaveProperty('value', '2026-01-01');
  expect(screen.getByLabelText('生效结束')).toHaveProperty('value', '2026-06-30');
  expect(screen.getByLabelText('备注')).toHaveProperty('value', '合成版本说明');
  fireEvent.change(screen.getByLabelText('版本编号'), { target: { value: 'rl-copy-new' } });
  fireEvent.click(screen.getByRole('button', { name: '保存版本' }));
  await waitFor(() => expect(copied).toHaveBeenCalledWith(9));
  expect(api).toHaveBeenCalledWith('/finance/labor/versions/1/copy', { method: 'POST', body: { versionCode: 'RL-COPY-NEW', versionName: '合成春季 - 副本', periodName: '2026春', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', remark: '合成版本说明' } });
});

it('复制版本沿用两个版本分区，不提供普通新增草稿；必填校验在请求前执行', () => {
  render(<CopyVersionDialog source={dto(1, 'finance-labor-versions', '合成', { versionCode: 'A' })} onClose={vi.fn()} onCopied={vi.fn()}/>);
  const dialog = screen.getByRole('dialog', { name: '复制人力成本版本' });
  expect(within(screen.getByRole('region', { name: '版本信息' })).getByLabelText('版本名称')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: '适用期间' })).getByLabelText('备注')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '保存草稿' })).toBeNull();
  fireEvent.change(screen.getByLabelText('版本编号'), { target: { value: '  ' } });
  fireEvent.submit(dialog);
  expect(screen.getByRole('alert')).toHaveProperty('textContent', '请填写版本编号');
  expect(document.activeElement).toBe(screen.getByLabelText('版本编号'));
  expect(api).not.toHaveBeenCalled();
});

it('复制版本重复提交仅请求一次，失败保留输入并允许重试', async () => {
  let fail!: (error: unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const copied = vi.fn(), close = vi.fn();
  render(<CopyVersionDialog source={dto(1, 'finance-labor-versions', '合成', { versionCode: 'A' })} onClose={close} onCopied={copied}/>);
  fireEvent.change(screen.getByLabelText('版本编号'), { target: { value: 'retry' } });
  const dialog = screen.getByRole('dialog', { name: '复制人力成本版本' });
  fireEvent.submit(dialog); fireEvent.submit(dialog);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(api).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true);
  await act(async () => fail(new ApiError(409, '合成版本编号重复')));
  expect(screen.getByRole('alert')).toHaveProperty('textContent', '合成版本编号重复');
  expect(screen.getByLabelText('版本编号')).toHaveProperty('value', 'RETRY');
  vi.mocked(api).mockResolvedValueOnce({ id: 99 });
  fireEvent.click(screen.getByRole('button', { name: '保存版本' }));
  await waitFor(() => expect(copied).toHaveBeenCalledWith(99));
});

it('复制窗口卸载后迟到的成功结果不执行切换回调', async () => {
  let finish!: (result: unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const copied = vi.fn();
  const view = render(<CopyVersionDialog source={dto(1, 'finance-labor-versions', '合成', { versionCode: 'A' })} onClose={vi.fn()} onCopied={copied}/>);
  fireEvent.click(screen.getByRole('button', { name: '保存版本' }));
  view.unmount();
  await act(async () => finish({ id: 99 }));
  expect(copied).not.toHaveBeenCalled();
});
