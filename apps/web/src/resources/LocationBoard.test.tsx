import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), changeStatus: vi.fn(), remove: vi.fn(), data: {} as Record<string, unknown[]> }));
vi.mock('./useResourceCan', () => ({ useResourceCan: () => () => true }));
vi.mock('./api', async (orig) => {
  const m = await orig<typeof import('./api')>();
  return { ...m, resourceApi: { ...m.resourceApi, create: h.create, update: h.update, changeStatus: h.changeStatus, remove: h.remove }, assetApi: { ...m.assetApi, locationContents: vi.fn().mockResolvedValue([]) } };
});
vi.mock('./treeNodes', async (orig) => {
  const m = await orig<typeof import('./treeNodes')>();
  return { ...m, loadAll: vi.fn(async (t: string) => h.data[t] ?? []), loadTreeNodes: vi.fn(async () => []), clearTreeNodes: vi.fn() };
});
vi.mock('./RecordForm', () => ({ clearRefCache: vi.fn(), RecordForm: ({ def, initial }: { def: { key: string }; initial: Record<string, unknown> }) => <div data-testid="form">{def.key}:{JSON.stringify(initial)}</div> }));
vi.mock('./RecordDetail', () => ({ RecordDetail: ({ def, id }: { def: { key: string }; id: number }) => <div data-testid="detail">{def.key}#{id}</div> }));
import { LocationBoard } from './LocationBoard';

const dto = (type: string, id: number, title: string, data: Record<string, unknown> = {}, status = 'normal', refLabels: Record<string, string> = {}) => ({ id, type, title, status, statusReason: null, data: { ...data }, secretConfigured: {}, refLabels, files: {}, createdAt: '', updatedAt: '' });

beforeEach(() => {
  h.data = {
    locations: [
      dto('locations', 1, '总部楼', { scope: 'area', locationType: 'building', sort: 10 }),
      dto('locations', 2, '二楼', { scope: 'area', locationType: 'floor', parentId: 1, sort: 10 }),
      dto('locations', 3, '财务室', { scope: 'area', locationType: 'room', parentId: 2, sort: 10 }),
      dto('locations', 20, '第一层', { scope: 'asset_space', locationType: 'shelf', fixedAssetId: 10, sort: 10 }),
      dto('locations', 21, '抽屉甲', { scope: 'asset_space', locationType: 'drawer', parentId: 20, fixedAssetId: 10, sort: 10 }),
      dto('locations', 4, '旧库房', { scope: 'area', locationType: 'room', parentId: 1, sort: 20 }, 'inactive'),
    ],
    'fixed-assets': [dto('fixed-assets', 10, '档案柜', { assetNo: 'ASSET-1', locationId: 3 }, 'idle', { locationId: '财务室' })],
    archives: [
      dto('archives', 100, '营业执照', { archiveNo: 'A1', locationId: 21, archiveType: '证照' }, 'stored'),
      dto('archives', 101, '年度合同', { archiveNo: 'A2', locationId: 3, archiveType: '合同' }, 'borrowed'),
      dto('archives', 102, '外面的档案', { archiveNo: 'A3', locationId: 1, archiveType: '合同' }, 'stored'),
    ],
  };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); try { localStorage.clear(); } catch { /* */ } });

const archivesPanel = () => screen.getByRole('region', { name: '档案' });
const areaPanel = () => screen.getByRole('region', { name: '区域位置' });
const storagePanel = () => screen.getByRole('region', { name: '固定资产储物空间' });

describe('房间与档案位置看板', () => {
  it('纵向三块：区域位置、固定资产储物空间、档案；顶部有新增区域、新增储物空间、新增档案和显示停用', async () => {
    render(<LocationBoard />);
    await screen.findByRole('region', { name: '区域位置' });
    expect(screen.getByRole('region', { name: '固定资产储物空间' })).toBeTruthy();
    expect(archivesPanel()).toBeTruthy();
    for (const t of ['＋ 新增区域', '＋ 新增储物空间', '＋ 新增档案']) expect(screen.getByRole('button', { name: t })).toBeTruthy();
    expect(screen.getByRole('button', { name: '显示停用 1' })).toBeTruthy();
    // 没选位置：全部档案
    expect(within(archivesPanel()).getByText('营业执照')).toBeTruthy();
    expect(within(archivesPanel()).getByText('外面的档案')).toBeTruthy();
  });

  it('区域位置一级级往右展开，档案跟着选中的位置过滤；含下级包含放在房间里的柜子内容', async () => {
    render(<LocationBoard />);
    fireEvent.click(await within(await screen.findByRole('region', { name: '区域位置' })).findByRole('button', { name: /总部楼/ }));
    expect(within(areaPanel()).getByRole('region', { name: '二级区域' })).toBeTruthy();
    expect(within(archivesPanel()).getAllByRole('row').length).toBe(4); // 表头 + 3 份
    fireEvent.click(within(areaPanel()).getByRole('button', { name: /二楼/ }));
    fireEvent.click(within(areaPanel()).getByRole('button', { name: /财务室/ }));
    const rows = within(archivesPanel()).getAllByRole('row');
    expect(rows.length).toBe(3); // 年度合同 + 柜子里的营业执照
    expect(within(archivesPanel()).queryByText('外面的档案')).toBeNull();
    expect(within(archivesPanel()).getByText(/借出或遗失 1 份/)).toBeTruthy();
    // 小标签：点哪级回到哪级
    fireEvent.click(within(areaPanel()).getByRole('button', { name: '二楼', pressed: undefined }));
    expect(within(archivesPanel()).getAllByRole('row').length).toBe(3);
    fireEvent.click(within(areaPanel()).getByRole('button', { name: '全部区域' }));
    expect(within(archivesPanel()).getAllByRole('row').length).toBe(4);
  });

  it('取消“含下级”后只看这个位置本身', async () => {
    render(<LocationBoard />);
    const area = await screen.findByRole('region', { name: '区域位置' });
    fireEvent.click(within(area).getByRole('button', { name: /总部楼/ }));
    fireEvent.click(screen.getByLabelText('含下级'));
    expect(within(archivesPanel()).getAllByRole('row').length).toBe(2);
    expect(within(archivesPanel()).getByText('外面的档案')).toBeTruthy();
  });

  it('储物空间：先选固定资产，再逐级点开柜层、抽屉；档案跟着走', async () => {
    render(<LocationBoard />);
    await screen.findByRole('region', { name: '区域位置' });
    expect(within(storagePanel()).getByText('先选择固定资产')).toBeTruthy();
    fireEvent.click(within(storagePanel()).getByRole('button', { name: /ASSET-1 · 档案柜/ }));
    expect(within(storagePanel()).getByRole('region', { name: '一级空间' })).toBeTruthy();
    expect(within(archivesPanel()).getAllByRole('row').length).toBe(2); // 这个柜子里的 1 份
    fireEvent.click(within(storagePanel()).getByRole('button', { name: /第一层/ }));
    expect(within(storagePanel()).getByRole('region', { name: '二级空间' })).toBeTruthy();
    fireEvent.click(within(storagePanel()).getByRole('button', { name: /抽屉甲/ }));
    expect(within(archivesPanel()).getByText('营业执照')).toBeTruthy();
    expect(within(archivesPanel()).getAllByText(/档案柜 \/ 第一层 \/ 抽屉甲/).length).toBeGreaterThan(0);
  });

  it('区域里放着的固定资产可以一点就跳到它的储物空间', async () => {
    render(<LocationBoard />);
    const area = await screen.findByRole('region', { name: '区域位置' });
    fireEvent.click(within(area).getByRole('button', { name: /总部楼/ }));
    fireEvent.click(within(area).getByRole('button', { name: /二楼/ }));
    fireEvent.click(within(area).getByRole('button', { name: /财务室/ }));
    fireEvent.click(within(area).getByRole('button', { name: /档案柜/ }));
    expect(within(storagePanel()).getByRole('region', { name: '一级空间' })).toBeTruthy();
  });

  it('管理：就地新增（带上级和类型）、改名、停用、删除要写原因', async () => {
    h.create.mockResolvedValue(dto('locations', 30, '三楼', {}));
    h.update.mockResolvedValue({}); h.changeStatus.mockResolvedValue({}); h.remove.mockResolvedValue({});
    render(<LocationBoard />);
    const area = await screen.findByRole('region', { name: '区域位置' });
    fireEvent.click(within(area).getByRole('button', { name: '管理' }));
    fireEvent.click(within(area).getByRole('button', { name: '新增' }));
    fireEvent.change(within(area).getByLabelText('区域名称'), { target: { value: '分部楼' } });
    fireEvent.click(within(area).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(h.create).toHaveBeenCalledWith('locations', { name: '分部楼', locationType: 'building', scope: 'area' }));

    fireEvent.click(within(area).getByRole('button', { name: '改名「总部楼」' }));
    fireEvent.change(within(area).getByLabelText('区域名称'), { target: { value: '总部大楼' } });
    fireEvent.click(within(area).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith('locations', 1, { name: '总部大楼' }));

    fireEvent.click(within(area).getByRole('button', { name: '停用「总部楼」' }));
    await waitFor(() => expect(h.changeStatus).toHaveBeenCalledWith('locations', 1, 'inactive', expect.any(String)));

    fireEvent.click(within(area).getByRole('button', { name: '删除「总部楼」' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.click(within(dlg).getByRole('button', { name: '确认删除' }));
    expect(h.remove).not.toHaveBeenCalled(); // 没写原因不提交
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: '拆除了' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('locations', 1, '拆除了'));
  });

  it('管理：同一列里上移下移重新写排序', async () => {
    h.update.mockResolvedValue({});
    h.data.locations.push(dto('locations', 5, '分部楼', { scope: 'area', locationType: 'building', sort: 20 }));
    render(<LocationBoard />);
    const area = await screen.findByRole('region', { name: '区域位置' });
    fireEvent.click(within(area).getByRole('button', { name: '管理' }));
    fireEvent.click(within(area).getByRole('button', { name: '上移「分部楼」' }));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith('locations', 5, { sort: 10 }));
    expect(h.update).toHaveBeenCalledWith('locations', 1, { sort: 20 });
  });

  it('新增储物空间：没选固定资产先提示；选了以后带着固定资产和上级打开表单', async () => {
    render(<LocationBoard />);
    await screen.findByRole('region', { name: '区域位置' });
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增储物空间' }));
    expect(screen.getByText(/请先在“固定资产储物空间”里选一项固定资产/)).toBeTruthy();
    expect(screen.queryByTestId('form')).toBeNull();
    fireEvent.click(within(storagePanel()).getByRole('button', { name: /ASSET-1 · 档案柜/ }));
    fireEvent.click(within(storagePanel()).getByRole('button', { name: /第一层/ }));
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增储物空间' }));
    expect(screen.getByTestId('form').textContent).toBe('locations:' + JSON.stringify({ scope: 'asset_space', fixedAssetId: 10, parentId: 20, locationType: 'drawer' }));
  });

  it('新增区域、新增档案带上当前选中的位置', async () => {
    render(<LocationBoard />);
    const area = await screen.findByRole('region', { name: '区域位置' });
    fireEvent.click(within(area).getByRole('button', { name: /总部楼/ }));
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增区域' }));
    expect(screen.getByTestId('form').textContent).toBe('locations:' + JSON.stringify({ scope: 'area', parentId: 1, locationType: 'floor' }));
    cleanup();
    render(<LocationBoard />);
    const area2 = await screen.findByRole('region', { name: '区域位置' });
    fireEvent.click(within(area2).getByRole('button', { name: /总部楼/ }));
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增档案' }));
    expect(screen.getByTestId('form').textContent).toBe('archives:' + JSON.stringify({ locationId: 1 }));
  });

  it('显示停用：打开后停用的位置出现在列里', async () => {
    render(<LocationBoard />);
    const area = await screen.findByRole('region', { name: '区域位置' });
    fireEvent.click(within(area).getByRole('button', { name: /总部楼/ }));
    expect(within(area).queryByRole('button', { name: /旧库房/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '显示停用 1' }));
    expect(within(area).getByRole('button', { name: /旧库房/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '隐藏停用' })).toBeTruthy();
  });
});
