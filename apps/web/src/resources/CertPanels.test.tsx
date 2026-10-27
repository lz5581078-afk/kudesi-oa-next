import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { DerivedStoresPanel, PhoneArchiveButton, ReturnBorrowButton, StoreAssignButton, StoreReleaseButton } from './CertPanels';

describe('证照与主体面板', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('登记归还：先改状态为已归还，再写归还日期和说明', async () => {
    const status = vi.spyOn(resourceApi, 'changeStatus').mockResolvedValue({} as never);
    const update = vi.spyOn(resourceApi, 'update').mockResolvedValue({} as never);
    const done = vi.fn();
    render(<ReturnBorrowButton id={7} onDone={done} onError={() => undefined} />);
    fireEvent.click(screen.getByText('登记归还'));
    fireEvent.change(screen.getByLabelText('归还日期'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '完好' } });
    fireEvent.click(screen.getByText('确认归还'));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(status).toHaveBeenCalledWith('license-borrows', 7, 'returned');
    expect(update).toHaveBeenCalledWith('license-borrows', 7, { returnedAt: '2026-10-20', note: '完好' });
  });

  it('适用店铺：按所属执照列出店铺；没有执照时提示', async () => {
    vi.spyOn(resourceApi, 'list').mockResolvedValue({ items: [{ id: 1, title: '甲店', status: 'normal', data: { storeNo: 'A1' }, refLabels: { operatorUserId: '小王' } }], total: 1, page: 1, pageSize: 100 } as never);
    render(<DerivedStoresPanel licenseId={5} />);
    expect(await screen.findByText(/甲店/)).toBeTruthy();
    cleanup();
    render(<DerivedStoresPanel licenseId={null} />);
    expect(screen.getByText('还没有关联营业执照')).toBeTruthy();
  });

  it('预留手机号没有档案时，一键建档并绑定；已绑定则不显示', async () => {
    const create = vi.spyOn(resourceApi, 'create').mockResolvedValue({ id: 99 } as never);
    const update = vi.spyOn(resourceApi, 'update').mockResolvedValue({} as never);
    const done = vi.fn();
    const rec = { id: 3, title: 'x', data: { reservedPhoneNumber: '13800000000' } } as never;
    render(<PhoneArchiveButton type="bank-accounts" record={rec} numberKey="reservedPhoneNumber" idKey="phoneId" holder="张三" onDone={done} onError={() => undefined} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith('phones', { number: '13800000000', usageType: 'external_used', externalUser: '张三' });
    expect(update).toHaveBeenCalledWith('bank-accounts', 3, { phoneId: 99 });
    cleanup();
    const bound = { id: 3, title: 'x', data: { reservedPhoneNumber: '13800000000', phoneId: 5 } } as never;
    const { container } = render(<PhoneArchiveButton type="bank-accounts" record={bound} numberKey="reservedPhoneNumber" idKey="phoneId" holder="" onDone={done} onError={() => undefined} />);
    expect(container.textContent).toBe('');
  });

  it('收回为公共店铺：清空运营人并留一条退店记录；公共店铺不显示按钮', async () => {
    const update = vi.spyOn(resourceApi, 'update').mockResolvedValue({} as never);
    const create = vi.spyOn(resourceApi, 'create').mockResolvedValue({} as never);
    const done = vi.fn();
    const rec = { id: 3, title: '甲店', status: 'normal', data: { claimStatus: 'claimed', operatorUserId: 9 } } as never;
    render(<StoreReleaseButton record={rec} onDone={done} onError={() => undefined} />);
    fireEvent.click(screen.getByText('收回为公共店铺'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '运营离职' } });
    fireEvent.click(screen.getByText('收回'));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('stores', 3, { claimStatus: 'public', operatorUserId: null });
    expect(create).toHaveBeenCalledWith('store-claims', expect.objectContaining({ storeId: 3, action: 'return', userId: 9, note: '收回为公共店铺：运营离职' }));
    cleanup();
    const pub = { id: 4, title: '乙店', status: 'normal', data: { claimStatus: 'public' } } as never;
    const { container } = render(<StoreReleaseButton record={pub} onDone={done} onError={() => undefined} />);
    expect(container.textContent).toBe('');
  });

  it('指派运营：必填人员和原因；推广限制要解除日；保存写店铺并留一条带原因的领退店记录', async () => {
    vi.spyOn(resourceApi, 'users').mockResolvedValue([{ id: 9, name: '小王', active: true }, { id: 8, name: '老李', active: false }] as never);
    const update = vi.spyOn(resourceApi, 'update').mockResolvedValue({} as never);
    const create = vi.spyOn(resourceApi, 'create').mockResolvedValue({} as never);
    const done = vi.fn();
    render(<StoreAssignButton record={{ id: 3, title: '甲店', status: 'normal', data: { claimStatus: 'public' } } as never} onDone={done} onError={() => undefined} />);
    fireEvent.click(screen.getByText('指派运营'));
    fireEvent.click(screen.getByText('指派'));
    expect(await screen.findByText('请选择运营人员')).toBeTruthy();
    expect(screen.queryByText('老李')).toBeNull();
    fireEvent.change(await screen.findByLabelText('运营人员'), { target: { value: '9' } });
    fireEvent.click(screen.getByText('指派'));
    expect(await screen.findByText('请填写指派原因')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('领取状态'), { target: { value: 'promotion_limited' } });
    fireEvent.change(screen.getByLabelText('指派原因'), { target: { value: '新员工接手' } });
    fireEvent.click(screen.getByText('指派'));
    expect(await screen.findByText(/请填写推广限制解除日期/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('推广限制解除日期'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByText('指派'));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('stores', 3, { operatorUserId: 9, claimStatus: 'promotion_limited', promotionReleaseAt: '2026-12-01' });
    expect(create).toHaveBeenCalledWith('store-claims', expect.objectContaining({ storeId: 3, action: 'claim', userId: 9, note: '指派运营：小王。原因：新员工接手' }));
  });
});
