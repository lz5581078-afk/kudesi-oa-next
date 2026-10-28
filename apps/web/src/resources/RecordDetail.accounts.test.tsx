import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, get: vi.fn(), relations: vi.fn(), logs: vi.fn(), reveal: vi.fn() } };
});
import { RecordDetail } from './RecordDetail';

const base = { status: 'normal', statusReason: null, secretConfigured: {}, files: {}, createdAt: '', updatedAt: '' };
const show = (type: string, id: number) => render(<MemoryRouter><RecordDetail def={getResourceDef(type)!} id={id} onClose={() => undefined} onChanged={() => undefined} /></MemoryRouter>);

beforeEach(() => { vi.mocked(resourceApi.logs).mockResolvedValue([] as never); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('自媒体账号详情（按 24 日布局的信息结构）', () => {
  it('分区：账号基础资料 / 运营人员 / 认证人 / 关联信息 / 当前平台专属属性 / 状态与备注；专属属性分区标题随平台变化，只显示当前平台的字段', async () => {
    vi.mocked(resourceApi.get).mockResolvedValue({ ...base, id: 9, type: 'self-media', title: '种子号', data: { platform: 'douyin', name: '种子号', accountNo: 'dy001', phoneNumber: '13900000000', operatorUserId: 5, operatorDeptId: 2, douyinShopId: 'D-1', followers: 1200, propSummary: '抖店ID：D-1' }, refLabels: { operatorUserId: '小运营', operatorDeptId: '短视频部', storeId: '抖店一号' } } as never);
    vi.mocked(resourceApi.relations).mockResolvedValue([] as never);
    show('self-media', 9);
    const nav = await screen.findByRole('navigation', { name: '分区导航' });
    const anchors = within(nav).getAllByRole('button').map((b) => b.textContent!.replace(/\d+$/, ''));
    expect(anchors).toEqual(['账号基础资料', '运营人员', '认证人', '关联信息', '抖音专属属性', '状态与备注']);
    expect(screen.getByText('抖店ID')).toBeTruthy();
    expect(screen.queryByText('快手小店ID')).toBeNull();
    expect(screen.queryByText('账号属性')).toBeNull(); // 列表摘要列不在详情里重复
    expect(screen.getAllByText('短视频部').length).toBeGreaterThan(0); // 运营部门
  });
});

describe('关联页签按对方类型分块并带关键信息', () => {
  it('手机号的关联：店铺、自媒体各一块，每个对象带平台/状态等摘要和“由哪个字段产生”', async () => {
    vi.mocked(resourceApi.get).mockResolvedValue({ ...base, id: 3, type: 'phones', title: '13600000001', data: { number: '13600000001', usageType: 'company_kept' }, refLabels: {} } as never);
    vi.mocked(resourceApi.relations).mockResolvedValue([
      { direction: 'in', relation: 'phoneId', relationLabel: '手机号档案', type: 'stores', id: 1, title: '拼店', summary: '拼多多 · S-1' },
      { direction: 'in', relation: 'phoneId', relationLabel: '手机号档案', type: 'self-media', id: 2, title: '快手号', summary: '快手 · ks001' },
      { direction: 'in', relation: 'phoneId', relationLabel: '关联手机号档案', type: 'stores', id: 4, title: '淘店', summary: '淘宝' },
    ] as never);
    show('phones', 3);
    fireEvent.click(await screen.findByRole('tab', { name: '关联 3' }));
    expect(await screen.findByText('拼多多 · S-1')).toBeTruthy();
    const titles = Array.from(document.querySelectorAll('.rd-rel-title')).map((e) => e.textContent);
    expect(titles).toEqual(['店铺档案2', '自媒体账号1']);
    expect(screen.getAllByText(/手机号档案（由对方维护）/).length).toBe(3);
  });
});
