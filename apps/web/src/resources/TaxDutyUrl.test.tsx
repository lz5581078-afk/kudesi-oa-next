import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi } from './api';
import { urlOf } from './CopyValue';
import { DutyGroupSummary } from './DutyGroupSummary';
import { TaxPendingButton } from './TaxPendingDialog';

describe('税务待生成、职责组概况、网址链接', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('税务页：按钮带待生成数量并提示，点开可见执照', async () => {
    vi.spyOn(resourceApi, 'list').mockImplementation(async (type: string) => (type === 'licenses'
      ? { items: [{ id: 1, title: '甲公司', status: 'normal', data: { creditCode: 'X1', category: 'operation' } }, { id: 2, title: '乙公司', status: 'normal', data: { category: 'ecommerce' } }], total: 2, page: 1, pageSize: 200 }
      : { items: [{ id: 9, title: '甲', status: 'normal', data: { licenseId: 1, taxCategory: 'operation' } }], total: 1, page: 1, pageSize: 200 }) as never);
    render(<TaxPendingButton refreshKey={1} onCreated={() => undefined} />);
    expect(await screen.findByText('待生成（1）')).toBeTruthy();
    expect(screen.getByText('1 张营业执照还没有税务资料')).toBeTruthy();
    fireEvent.click(screen.getByText('待生成（1）'));
    expect(await screen.findByText(/乙公司/)).toBeTruthy();
  });

  it('职责组：显示成员/职责条数，没有成员时提示', async () => {
    vi.spyOn(resourceApi, 'list').mockImplementation(async (type: string) => ({ items: [], total: type === 'duty-group-members' ? 0 : 3, page: 1, pageSize: 1 }) as never);
    render(<DutyGroupSummary groupId={5} />);
    expect(await screen.findByText('成员 0 人')).toBeTruthy();
    expect(screen.getByText('职责明细 3 条')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/还没有成员/)).toBeTruthy());
  });

  it('主页链接/登录地址识别为网址，其他字段不是', () => {
    const f = (key: string) => ({ key } as never);
    expect(urlOf(f('homepage'), 'https://v.douyin.com/x')).toBe('https://v.douyin.com/x');
    expect(urlOf(f('url'), 'aliyun.com/login')).toBe('https://aliyun.com/login');
    expect(urlOf(f('url'), 'javascript:alert(1)')).toBeNull();
    expect(urlOf(f('accountNo'), 'https://a.com')).toBeNull();
    expect(getResourceDef('self-media')).toBeTruthy();
  });
});
