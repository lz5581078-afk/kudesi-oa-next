import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { ResourceOverviewPage } from './OverviewPage';

const exp = (n: number, type = 'qualifications', typeLabel = '资质证照') => Array.from({ length: n }, (_, i) => ({ type, typeLabel, id: i + 1, name: `${typeLabel}${i + 1}`, field: 'expiresAt', fieldLabel: '到期日', dueDate: '2026-11-01', daysLeft: i - 1, status: i < 1 ? 'expired' : 'due_soon', resourceStatus: 'normal' }));

beforeEach(() => {
  vi.spyOn(resourceApi, 'overview').mockResolvedValue({ items: [{ type: 'stores', label: '店铺档案', total: 5, abnormal: 1 }, { type: 'phones', label: '手机号', total: 9, abnormal: 0 }, { type: 'licenses', label: '营业执照', total: 3, abnormal: 0 }] });
  vi.spyOn(resourceApi, 'expiring').mockResolvedValue({ today: '2026-10-27', days: 30, total: 7, counts: { expired: 1, dueSoon: 6 }, rows: exp(7) } as never);
  vi.spyOn(resourceApi, 'dataIssues').mockResolvedValue({ total: 8, groups: [{ key: 'a', label: '手机号未建档', description: '预留手机号没有档案', resourceType: 'bank-accounts', count: 8, rows: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, type: 'bank-accounts', name: `账户${i + 1}`, detail: '' })) }, { key: 'b', label: '关联冲突', description: '', resourceType: 'stores', count: 0, rows: [] }] });
  vi.spyOn(resourceApi, 'recentChanges').mockResolvedValue([{ id: '1', type: 'stores', typeLabel: '店铺档案', resourceId: 3, name: '甲店', action: 'update', note: '改了运营', actor: '小王', createdAt: '2026-10-27T01:00:00Z' }]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderPage = () => render(<MemoryRouter><ResourceOverviewPage /></MemoryRouter>);

describe('资料总览', () => {
  it('数量按菜单分组；到期提醒按资料类型分组、默认只列前 5 条，可展开，可只看已过期', async () => {
    renderPage();
    expect(await screen.findByText('经营资料')).toBeTruthy();
    expect(await screen.findByText('账号与资质')).toBeTruthy();
    expect(await screen.findByText('资质证照5')).toBeTruthy();
    expect(screen.queryByText('资质证照6')).toBeNull();
    fireEvent.click(screen.getByText('展开全部 7 条'));
    expect(screen.getByText('资质证照7')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /已过期 1/ }));
    await waitFor(() => expect(screen.queryByText('资质证照2')).toBeNull());
    expect(screen.getByText('资质证照1')).toBeTruthy();
  });

  it('数据问题只预览 5 条可展开，没问题的分组写明；最近变更显示资料名、操作和操作人', async () => {
    renderPage();
    const issue = await screen.findByLabelText('数据问题：手机号未建档');
    expect(within(issue).queryByText('账户6')).toBeNull();
    fireEvent.click(within(issue).getByText('展开全部 8 条'));
    expect(within(issue).getByText('账户8')).toBeTruthy();
    expect(screen.getByLabelText('数据问题：关联冲突').textContent).toContain('没有发现这类问题');
    expect(await screen.findByText('甲店')).toBeTruthy();
    expect(screen.getByText(/改了运营/)).toBeTruthy();
    expect(screen.getByText('小王')).toBeTruthy();
  });

  it('某一块读取失败只影响自己，可以重新读取', async () => {
    const spy = vi.spyOn(resourceApi, 'recentChanges').mockRejectedValueOnce(new Error('x')).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(await screen.findByText('店铺档案')).toBeTruthy();
    fireEvent.click(screen.getByText('重新读取'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('未建档手机号：每行有「建立手机号档案并绑定」，点后显示结果并刷新', async () => {
    const issues = vi.spyOn(resourceApi, 'dataIssues').mockResolvedValue({ total: 1, groups: [{ key: 'bank_phone_text_unlinked', label: '银行预留手机没有关联手机号档案', description: 'd', resourceType: 'bank-accounts', count: 1, rows: [{ id: 7, type: 'bank-accounts', name: '工行公户', detail: '预留手机 13800138000：未关联档案' }] }] });
    const create = vi.spyOn(resourceApi, 'createPhone').mockResolvedValue({ created: true, number: '13800138000', phoneId: 3 });
    renderPage();
    const g = await screen.findByLabelText('数据问题：银行预留手机没有关联手机号档案');
    fireEvent.click(within(g).getByText('建立手机号档案并绑定'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('bank-accounts', 7));
    await waitFor(() => expect(issues).toHaveBeenCalledTimes(2));
  });
});
