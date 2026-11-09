import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MyStores } from './MyStores';
import { DeskApplications } from './DeskApplications';
import { workspaceApi } from './workspaceApi';
import { flowApi } from '../flow/flowApi';
vi.mock('./workspaceApi', () => ({ workspaceApi: { myStores: vi.fn() } }));
vi.mock('../flow/flowApi', () => ({ flowApi: { templates: vi.fn() } }));
vi.mock('../flow/ApplyPage', () => ({ ApplyPage: () => null }));
vi.mock('../flow/SkuApplicationCenter', () => ({ SkuApplicationCenter: () => <div role="dialog">SKU申请表</div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('点击后读取本人店铺，显示平台数量，切换平台仅显示对应店铺', async () => {
  vi.mocked(workspaceApi.myStores).mockResolvedValue([
    { id: 1, name: '春天店', platform: 'douyin', platformLabel: '抖音' },
    { id: 2, name: '夏天店', platform: 'douyin', platformLabel: '抖音' },
    { id: 3, name: '秋天店', platform: 'pdd', platformLabel: '拼多多' },
  ]);
  render(<MyStores />);
  expect(workspaceApi.myStores).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '我的店铺' }));
  await screen.findByText('共 3 家店铺');
  expect(screen.getByRole('button', { name: '抖音 2' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '拼多多 1' }));
  const list = within(screen.getByRole('list', { name: '店铺列表' }));
  expect(list.getByText('秋天店')).toBeTruthy();
  expect(list.queryByText('春天店')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '全部 3' }));
  expect(list.getAllByRole('listitem')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('失败可重试，空列表明确说明未分配', async () => {
  vi.mocked(workspaceApi.myStores).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
  render(<MyStores />);
  fireEvent.click(screen.getByRole('button', { name: '我的店铺' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('暂无分配给你的店铺')).toBeTruthy();
});
it('运营申请仅保留两项，不请求其他流程；SKU仍可打开', async () => {
  render(<MemoryRouter><DeskApplications operations sku purchase exclusive refreshKey={0} onSubmitted={() => {}} /></MemoryRouter>);
  expect(screen.getByText('专属品领取')).toBeTruthy();
  expect(screen.queryByText('采购申请中心')).toBeNull();
  expect(flowApi.templates).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'SKU 批量申请' }));
  expect(await screen.findByText('SKU申请表')).toBeTruthy();
});
it('其他岗位仍可发起采购和原有流程', async () => {
  vi.mocked(flowApi.templates).mockResolvedValue([{ key: 'expense-request', label: '费用申请', active: true, startable: true }] as never);
  render(<MemoryRouter><DeskApplications sku purchase exclusive refreshKey={0} onSubmitted={() => {}} /></MemoryRouter>);
  expect(await screen.findByText('费用申请')).toBeTruthy();
  expect(screen.getByText('采购申请中心')).toBeTruthy();
});
