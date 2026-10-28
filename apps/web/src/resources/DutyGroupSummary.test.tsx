import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../api/client', () => ({ api: vi.fn() }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn() } };
});
import { api } from '../api/client';
import { resourceApi } from './api';
import { DutyGroupSummary } from './DutyGroupSummary';

beforeEach(() => {
  vi.mocked(resourceApi.list).mockImplementation(async (type: string) => (type === 'duty-group-members'
    ? { items: [{ status: 'normal', title: 'x', refLabels: { userId: '王明' } }], total: 1 }
    : { items: [], total: 0 }) as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('职责组详情摘要', () => {
  it('显示所属部门、成员名单和被哪些流程引用', async () => {
    vi.mocked(api).mockResolvedValue([{ templateKey: 'license-borrow', label: '证照借用', version: 1, draft: true, stepName: '资质审核' }] as never);
    render(<DutyGroupSummary groupId={9} departmentLabel="总部 / 运营部" />);
    expect(await screen.findByText('成员 1 人')).toBeTruthy();
    expect(screen.getByText('总部 / 运营部')).toBeTruthy();
    expect(screen.getByText('王明')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('流程引用').textContent).toContain('证照借用「资质审核」（草稿）'));
  });
  it('没有部门显示“未分类”；看不到流程配置时整行不出现', async () => {
    vi.mocked(api).mockRejectedValue(new Error('403'));
    render(<DutyGroupSummary groupId={9} departmentLabel="" />);
    expect(await screen.findByText('未分类')).toBeTruthy();
    expect(screen.queryByLabelText('流程引用')).toBeNull();
  });
});
