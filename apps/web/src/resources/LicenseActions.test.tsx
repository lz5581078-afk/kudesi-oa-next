import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { LinkExistingStoresButton } from './LicenseActions';

describe('关联已有店铺', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('转移其他执照的店铺要先确认，保存后逐店更新所属执照', async () => {
    vi.spyOn(resourceApi, 'list').mockResolvedValue({ items: [
      { id: 1, title: '甲店', status: 'normal', data: { storeNo: 'A1' }, refLabels: {} },
      { id: 2, title: '乙店', status: 'normal', data: { licenseId: 9 }, refLabels: { licenseId: '别家公司' } },
    ], total: 2, page: 1, pageSize: 100 } as never);
    const update = vi.spyOn(resourceApi, 'update').mockResolvedValue({} as never);
    const done = vi.fn();
    render(<LinkExistingStoresButton license={{ id: 5, title: '本公司', status: 'normal', data: {}, refLabels: {} } as never} onDone={done} onError={() => undefined} />);
    fireEvent.click(screen.getByText('关联已有店铺'));
    fireEvent.click((await screen.findByText(/甲店/)).closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByText(/乙店/).closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByText('关联 2 个店铺'));
    expect(await screen.findByText(/请勾选下方确认/)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/确认把 1 个/));
    fireEvent.click(screen.getByText('关联 2 个店铺'));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('stores', 1, { licenseId: 5 });
    expect(update).toHaveBeenCalledWith('stores', 2, { licenseId: 5 });
  });
});
