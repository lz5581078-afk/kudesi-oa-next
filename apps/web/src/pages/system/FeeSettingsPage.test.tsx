import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LedgerBroadbandRow, LedgerPhoneRow, LedgerResult } from '@kudesi/shared';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./fee/feeApi', async (orig) => {
  const mod = await orig<typeof import('./fee/feeApi')>();
  return { ...mod, feeApi: { ledger: vi.fn(), save: vi.fn() } };
});
import { FeeSettingsPage } from './FeeSettingsPage';
import { feeApi } from './fee/feeApi';

const phone = (id: number, number: string, extra: Partial<LedgerPhoneRow> = {}): LedgerPhoneRow => ({
  id, version: `v${id}`, number, status: 'normal', carrier: '中国移动', plan: '商务套餐', kind: 'main', parentId: null, parentNumber: null,
  feeCents: 3000, feeCycle: 'monthly', monthlyCents: 3000, cycleDays: 30, rechargeDay: null, lastRechargeAt: '2026-10-01', nextRechargeAt: '2026-12-01',
  state: 'ok', daysLeft: 30, user: '张三', userKind: 'use', childCount: 0, broadband: [], ...extra,
});
const bb = (id: number, account: string, extra: Partial<LedgerBroadbandRow> = {}): LedgerBroadbandRow => ({
  id, version: `b${id}`, account, status: 'normal', locationId: 9, location: '总部大楼 / 3楼 / 运营室', bandwidth: '500M', cycle: 'yearly', amountCents: 120000, monthlyCents: 10000,
  expiresAt: '2026-11-20', state: 'soon', daysLeft: 23, phoneId: 1, phoneNumber: '13800000001', ...extra,
});
const summary = { monthlyCents: 21000, phoneMonthlyCents: 19000, broadbandMonthlyCents: 2000, mainCount: 2, subCount: 2, soonCount: 1, overdueCount: 1, noFeeCount: 1, orphanCount: 1, broadbandCount: 2, broadbandExpiringCount: 1, broadbandExpiredCount: 0, broadbandUnboundCount: 1, broadbandNoAreaCount: 1 };
const base = (over: Partial<LedgerResult>): LedgerResult => ({ today: '2026-10-28', view: 'main', canSeeFees: true, canSeeBroadband: true, summary, total: 0, page: 1, pageSize: 20, carriers: ['中国移动'], users: ['张三'], ...over });

const m1 = phone(1, '13800000001', { childCount: 2, broadband: [{ id: 5, account: 'bb-main' }] });
const s1 = phone(2, '13800000002', { kind: 'sub', parentId: 1, parentNumber: '13800000001', feeCents: 2000, monthlyCents: 2000, state: 'overdue', daysLeft: -3, nextRechargeAt: '2026-10-25' });
const s2 = phone(3, '13800000003', { kind: 'sub', parentId: 1, parentNumber: '13800000001', feeCents: 36000, feeCycle: 'yearly', monthlyCents: 3000 });
const m2 = phone(4, '13800000004');
const orphan = phone(7, '13800000007', { kind: 'sub', parentId: 99, parentNumber: null });

const mainResult = base({ view: 'main', total: 2, filteredMonthlyCents: 17000, groups: [{ main: m1, children: [s1, s2], monthlyCents: 8000, unpriced: 0 }, { main: m2, children: [], monthlyCents: 3000, unpriced: 0 }], orphans: [orphan] });

const show = () => render(<MemoryRouter><FeeSettingsPage /></MemoryRouter>);

beforeEach(() => {
  vi.mocked(feeApi.ledger).mockResolvedValue(mainResult);
  vi.mocked(feeApi.save).mockResolvedValue({ done: 1, failed: [] });
  window.confirm = vi.fn(() => true);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('费用模块：按主卡', () => {
  it('每张主卡一行，没有子卡的标“无子卡”；展开显示子卡和主子小计', async () => {
    show();
    await screen.findByText('13800000001');
    expect(screen.getByText('无子卡')).toBeTruthy();
    expect(screen.queryByText('13800000002')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '13800000001 的子卡' }));
    expect(screen.getByText('13800000002')).toBeTruthy();
    expect(screen.getByText('13800000003')).toBeTruthy();
    expect(screen.getByText(/小计：主卡 \+ 2 张子卡/).textContent).toContain('¥80.00');
  });

  it('“展开全部”一次展开所有主卡的子卡', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }));
    expect(screen.getByText('13800000003')).toBeTruthy();
    expect(screen.getByRole('button', { name: '折叠全部' })).toBeTruthy();
  });

  it('逾期的子卡标红“逾期 3 天”，年付子卡显示折合月均', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }));
    const flag = screen.getByText('逾期 3 天');
    expect(flag.className).toContain('bad');
    expect(screen.getByText(/折合 ¥30.00\/月/)).toBeTruthy();
  });

  it('孤立子卡单独红色提示，可就地补绑主卡', async () => {
    const pickable = base({ view: 'main', groups: [{ main: m2, children: [], monthlyCents: 3000, unpriced: 0 }], total: 1, orphans: [orphan] });
    vi.mocked(feeApi.ledger).mockResolvedValue(pickable);
    show();
    const box = await screen.findByRole('region', { name: '孤立子卡' });
    expect(box.textContent).toContain('13800000007');
    expect(box.textContent).toContain('原主卡：已不存在');
    const input = within(box).getByLabelText('主卡号');
    fireEvent.focus(input);
    const option = await screen.findByRole('option', { name: /13800000004/ });
    fireEvent.click(option);
    fireEvent.click(within(box).getByRole('button', { name: '绑定主卡 13800000007' }));
    await waitFor(() => expect(feeApi.save).toHaveBeenCalledWith('phones', [expect.objectContaining({ id: 7, version: 'v7', data: { parentPhoneId: 4 } })]));
  });
});

describe('费用模块：汇总、筛选与批量', () => {
  it('汇总可点：逾期 → 切到“全部号码”并按逾期过滤', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByRole('button', { name: /已逾期未充/ }));
    await waitFor(() => expect(feeApi.ledger).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'all', focus: 'overdue' })));
  });

  it('搜索走服务端', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '0002' } });
    await waitFor(() => expect(feeApi.ledger).toHaveBeenLastCalledWith(expect.objectContaining({ q: '0002', page: 1 })));
  });

  it('勾选多张、预览差异、确认后走资料保存通道写回', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByLabelText('勾选 13800000001'));
    fireEvent.click(screen.getByLabelText('勾选 13800000004'));
    fireEvent.click(screen.getByRole('button', { name: '批量修改…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText('改套餐'));
    fireEvent.change(within(dialog).getByLabelText('套餐'), { target: { value: '大流量套餐' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '预览修改' }));
    const region = await screen.findByRole('region', { name: '修改预览' });
    expect(region.textContent).toContain('商务套餐 → 大流量套餐');
    expect(feeApi.save).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }));
    await waitFor(() => expect(feeApi.save).toHaveBeenCalledTimes(1));
    expect(feeApi.save).toHaveBeenCalledWith('phones', [
      expect.objectContaining({ id: 1, data: { plan: '大流量套餐' } }),
      expect.objectContaining({ id: 4, data: { plan: '大流量套餐' } }),
    ]);
  });

  it('批量设主卡：有子卡的号码不能再设为子卡', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByLabelText('勾选 13800000001'));
    fireEvent.click(screen.getByLabelText('勾选 13800000004'));
    fireEvent.click(screen.getByRole('button', { name: '批量修改…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText('改主卡'));
    fireEvent.focus(within(dialog).getByLabelText('主卡号'));
    fireEvent.click(await screen.findByRole('option', { name: /13800000004/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '预览修改' }));
    expect((await screen.findByRole('alert')).textContent).toContain('不能再设为子卡');
    expect(feeApi.save).not.toHaveBeenCalled();
  });

  it('记录充值：确认后只写最后充值日，下次充值日由资料保存规则推算', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByRole('button', { name: '记录充值 13800000004' }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(feeApi.save).toHaveBeenCalledWith('phones', [expect.objectContaining({ id: 4, data: { lastRechargeAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } })]));
  });

  it('保存时有人先改过（版本冲突）：提示刷新，不覆盖', async () => {
    vi.mocked(feeApi.save).mockResolvedValue({ done: 0, failed: [{ title: '13800000004', message: '这条资料刚被别人修改过，请刷新后再改', conflict: true }] });
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByRole('button', { name: '记录充值 13800000004' }));
    expect((await screen.findByRole('alert')).textContent).toContain('刚被别人修改过');
  });
});

describe('费用模块：宽带', () => {
  const bbResult = base({ view: 'broadband', total: 2, filteredMonthlyCents: 10000, areas: [{ id: 9, path: '总部大楼 / 3楼 / 运营室', count: 1 }], broadband: [bb(5, 'bb-main'), bb(6, 'bb-old', { phoneId: null, phoneNumber: null, locationId: null, location: null, state: 'expired', daysLeft: -5, expiresAt: '2026-10-23' })] });
  beforeEach(() => { vi.mocked(feeApi.ledger).mockImplementation(async (p) => (p.view === 'broadband' ? bbResult : mainResult)); });

  it('宽带单独一张表：使用区域路径、绑定手机号；没绑手机号的标红，没区域的标“未指定区域”', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByRole('tab', { name: /^宽带/ }));
    await screen.findByText('bb-main');
    expect(screen.getByText('总部大楼 / 3楼 / 运营室')).toBeTruthy();
    const unbound = screen.getAllByText('未绑定手机号').find((e) => e.className.includes('fee-flag'))!;
    expect(unbound.className).toContain('bad');
    expect(screen.getByText('未指定区域')).toBeTruthy();
    expect(screen.getByText('已到期 5 天').className).toContain('bad');
    // 手机号可跳转手机号详情；宽带行可打开宽带档案
    expect(screen.getByRole('link', { name: '13800000001' }).getAttribute('href')).toBe('/resource/phones?open=1');
    expect(screen.getAllByRole('link', { name: '打开宽带档案' })[0].getAttribute('href')).toBe('/resource/broadband?open=5');
    expect(screen.getByText(/宽带单独汇总/)).toBeTruthy();
  });

  it('未绑定的宽带点“绑定手机号”进入修改，保存时必须选号码', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByRole('tab', { name: /^宽带/ }));
    await screen.findByText('bb-old');
    fireEvent.click(screen.getByRole('button', { name: '绑定手机号 bb-old' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('套餐金额（元）'), { target: { value: '99' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(feeApi.save).toHaveBeenCalledWith('broadband', [expect.objectContaining({ id: 6, data: { amount: 9900 } })]));
  });

  it('按使用区域筛选走服务端', async () => {
    show();
    await screen.findByText('13800000001');
    fireEvent.click(screen.getByRole('tab', { name: /^宽带/ }));
    await screen.findByText('bb-main');
    fireEvent.change(screen.getByLabelText('使用区域'), { target: { value: '9' } });
    await waitFor(() => expect(feeApi.ledger).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'broadband', location: 9 })));
  });
});

describe('费用模块：权限', () => {
  it('没有费用字段权限时，金额位置显示“无权限”，也没有批量改费用的入口', async () => {
    vi.mocked(feeApi.ledger).mockResolvedValue(base({ canSeeFees: false, summary: { ...summary, monthlyCents: undefined, phoneMonthlyCents: undefined, broadbandMonthlyCents: undefined }, groups: [{ main: { ...m2, feeCents: undefined, monthlyCents: undefined }, children: [], unpriced: 0 }], total: 1, orphans: [] }));
    show();
    await screen.findByText('13800000004');
    expect(screen.getAllByText('无权限').length).toBeGreaterThan(0);
    expect(screen.queryByText('月均通信费')).toBeNull();
  });
});
