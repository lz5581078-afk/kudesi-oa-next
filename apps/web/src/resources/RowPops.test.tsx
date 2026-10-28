import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ relations: vi.fn(), list: vi.fn() }));
vi.mock('./api', async (orig) => { const m = await orig<typeof import('./api')>(); return { ...m, resourceApi: { ...m.resourceApi, ...api } }; });
import { rowActionsFor } from './RowActions';
import type { ResourceDto } from './api';

const row = (over: Partial<ResourceDto>) => ({ id: 7, title: '王建国', status: 'active', data: {}, refLabels: {}, ...over } as ResourceDto);

describe('列表行里的“查看”小弹窗（24 号旧版 点击查看）', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('合作人：点“店铺”列出关联店铺（去重），只取这一类', async () => {
    api.relations.mockResolvedValue([{ direction: 'out', relation: 'ref', type: 'stores', id: 1, title: '青禾旗舰店' }, { direction: 'out', relation: 'manual', type: 'stores', id: 1, title: '青禾旗舰店' }, { direction: 'out', relation: 'ref', type: 'licenses', id: 2, title: '青禾种业' }]);
    render(<>{rowActionsFor('partners', () => false, vi.fn())!(row({}))}</>);
    fireEvent.click(screen.getByRole('button', { name: '店铺' }));
    await waitFor(() => expect(screen.getByText('青禾旗舰店')).toBeTruthy());
    expect(screen.getAllByText('青禾旗舰店').length).toBe(1);
    expect(screen.queryByText('青禾种业')).toBeNull();
  });

  it('营业执照：存放位置弹窗显示各处位置、缺失的章标出、借出情况', () => {
    render(<>{rowActionsFor('licenses', () => false, vi.fn())!(row({ data: { officialState: 'missing', borrowedSummary: '外部律师借走正本' }, refLabels: { locationId: '总部 / 保险柜' } }))}</>);
    fireEvent.click(screen.getByRole('button', { name: '存放位置' }));
    expect(screen.getByText('总部 / 保险柜')).toBeTruthy();
    expect(screen.getByText('实物缺失')).toBeTruthy();
    expect(screen.getByText('外部律师借走正本')).toBeTruthy();
  });

  it('资质/税务：关联店铺按所属执照取', async () => {
    api.list.mockResolvedValue({ items: [{ id: 3, title: '禾苗农资店', status: 'normal', data: { platform: 'taobao' }, refLabels: {} }] });
    render(<>{rowActionsFor('qualifications', () => false, vi.fn())!(row({ data: { licenseId: 9 } }))}</>);
    fireEvent.click(screen.getByRole('button', { name: '关联店铺' }));
    await waitFor(() => expect(screen.getByText(/禾苗农资店/)).toBeTruthy());
    expect(api.list).toHaveBeenCalledWith('stores', expect.objectContaining({ fieldKey: 'licenseId', fieldValue: 9 }));
  });
});
