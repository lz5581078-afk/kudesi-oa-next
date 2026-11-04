import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_TABS } from '@kudesi/shared';
import { ExpressWorkspace } from './ExpressWorkspace';
import { ExpressPricesPage } from './ExpressPricesPage';
import { expressApi } from './expressApi';
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../../resources/RecordDetail', () => ({ useResourceCan: () => () => true }));
vi.mock('./VersionPanel', () => ({ VersionPanel: ({ onBack }: { onBack: () => void }) => <div>合成版本详情<button type="button" onClick={onBack}>返回版本列表</button></div> }));
vi.mock('./expressApi', () => ({ expressApi: { tree: vi.fn(), zoneRuns: vi.fn(), remove: vi.fn() } }));
const carriers = [{ id: 1, name: '合成快递', status: 'normal', note: '', defaultBranchId: 2, branches: [{ id: 2, name: '合成网点', status: 'normal', jstLogisticsName: '', contactName: '', contactPhone: '', currentVersionId: 3, isDefault: true, versions: [{ id: 3, name: '合成版本', status: 'active', cooperationStatus: 'active', priceSource: 'manual', effectiveStart: '', effectiveEnd: '', shippingWeightMin: 0, shippingWeightMax: 30, isCurrent: true, aiRuleCount: 0, manualRuleCount: 1, surchargeCount: 0, inUse: true }] }] }];
const tabs = PAGE_TABS['finance/finance-express-prices'].map(tab => ({ ...tab, Component: tab.id === 'finance-express-prices' ? ExpressPricesPage : () => <p>{tab.label}合成内容</p> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('快递真实TabHost宿主', () => {
  it('唯一tab条使用原顺序，三个视图共用tab上方的四指标及单一标题', async () => {
    vi.mocked(expressApi.tree).mockResolvedValue({ carriers } as never);
    vi.mocked(expressApi.zoneRuns).mockResolvedValue({ total: 2, items: [] } as never);
    render(<MemoryRouter><ExpressWorkspace tabs={tabs} /></MemoryRouter>);
    await screen.findByText('合成网点');
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['经营网点', '分区建议', '成本表预估快递费']);
    const summary = screen.getByLabelText('快递价格汇总');
    expect(summary.compareDocumentPosition(screen.getByRole('tablist')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const label of ['分区建议', '成本表预估快递费', '经营网点']) {
      fireEvent.click(screen.getByRole('tab', { name: label }));
      await waitFor(() => expect(screen.getByLabelText('快递价格汇总').textContent).toContain('2建议记录'));
      expect(screen.getAllByRole('heading', { name: '快递价格表', level: 1 })).toHaveLength(1);
    }
  });
  it('删除公司按原确认窗提交，无新增原因字段，失败保留记录与确认窗', async () => {
    vi.mocked(expressApi.tree).mockResolvedValue({ carriers } as never);
    vi.mocked(expressApi.zoneRuns).mockResolvedValue({ total: 0, items: [] } as never);
    vi.mocked(expressApi.remove).mockRejectedValue(new Error('合成删除失败'));
    render(<MemoryRouter><ExpressWorkspace tabs={tabs} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '删除快递公司' }));
    const dialog = await screen.findByRole('dialog', { name: '确认删除' });
    expect(within(dialog).queryByLabelText('原因')).toBeNull();
    expect(within(dialog).getByText(/该快递公司下的经营网点/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await screen.findByText('操作失败');
    expect(expressApi.remove).toHaveBeenCalledWith('carriers', 1, '人工确认删除快递公司');
    expect(screen.getByText('合成网点')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '确认删除' })).toBeTruthy();
  });
  it('选网点/版本隐藏指标及tabs，面包屑仍能逐级返回', async () => {
    vi.mocked(expressApi.tree).mockResolvedValue({ carriers } as never);
    vi.mocked(expressApi.zoneRuns).mockResolvedValue({ total: 0, items: [] } as never);
    render(<MemoryRouter><ExpressWorkspace tabs={tabs} /></MemoryRouter>);
    await screen.findByText('合成网点');
    fireEvent.click(screen.getByRole('button', { name: '查看价格表' }));
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
    expect(screen.queryByLabelText('快递价格汇总')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    await screen.findByText('合成版本详情');
    fireEvent.click(screen.getByRole('button', { name: '合成网点' }));
    await screen.findByRole('region', { name: '价格版本列表' });
    fireEvent.click(screen.getByRole('button', { name: '快递公司' }));
    await screen.findByRole('tablist');
    expect(screen.getByRole('button', { name: '查看价格表' })).toBeTruthy();
  });
});
