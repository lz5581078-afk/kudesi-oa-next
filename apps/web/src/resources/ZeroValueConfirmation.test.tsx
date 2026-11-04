import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { ZeroValueConfirmation } from './ZeroValueConfirmation';
import { resourceApi, type ResourceDto } from './api';

const auth = vi.hoisted(() => ({ companyId: 1, id: 1 }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: auth }) }));
vi.mock('./api', () => ({ resourceApi: { get: vi.fn() } }));
const def = getResourceDef('finance-labor-costs')!;
const row = (title: string) => ({ title } as ResourceDto);
const values = { unitPrice: 0, workName: '合成装袋', unitId: 1, workTypeId: 2, zeroReason: '赠' };
beforeEach(() => { vi.resetAllMocks(); auth.companyId = 1; vi.mocked(resourceApi.get).mockImplementation(async (type, id) => row(type === 'finance-labor-units' ? id === 1 ? '元/袋' : '元/小时' : '包装')); });
afterEach(cleanup);

describe('零人力成本明确确认', () => {
  it('确认绑定当时名称/单位/分类，改名称或单位后旧确认不再显示为有效，需重新确认', async () => {
    const change = vi.fn(); const view = render(<ZeroValueConfirmation def={def} values={values} enabled onChange={change}/>);
    const button = screen.getByRole('button', { name: '确认该项为0' });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    const confirmation = { reason: '赠', context: JSON.stringify(['合成装袋', '元/袋', '包装']) };
    expect(change).toHaveBeenCalledWith({ unitPrice: 0, zeroReason: '赠', zeroCostConfirmation: confirmation });
    view.rerender(<ZeroValueConfirmation def={def} values={{ ...values, zeroCostConfirmation: confirmation }} enabled onChange={change}/>);
    expect(screen.getByText('已确认：赠')).toBeTruthy();
    view.rerender(<ZeroValueConfirmation def={def} values={{ ...values, workName: '合成改名', unitId: 3, zeroCostConfirmation: confirmation }} enabled onChange={change}/>);
    expect(screen.queryByText('已确认：赠')).toBeNull();
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ zeroCostConfirmation: { reason: '赠', context: JSON.stringify(['合成改名', '元/小时', '包装']) } }));
  });

  it('引用名称读取失败不能确认或用历史标签伪造，重试后恢复；无成本编辑权限时按钮和原因只读', async () => {
    vi.mocked(resourceApi.get).mockRejectedValueOnce(new Error('offline'));
    const change = vi.fn(); const view = render(<ZeroValueConfirmation def={def} values={values} enabled onChange={change}/>);
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: '确认该项为0' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '重试确认资料' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认该项为0' })).toHaveProperty('disabled', false));
    view.rerender(<ZeroValueConfirmation def={def} values={values} enabled={false} onChange={change}/>);
    expect(screen.getByRole('button', { name: '确认该项为0' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('textbox', { name: '零人力成本原因' })).toHaveProperty('disabled', true);
    expect(change).not.toHaveBeenCalled();
  });

  it('正价不显示零值确认，也不读取确认资料；切公司丢弃旧公司迟到的名称', async () => {
    let finish!: (row: ResourceDto) => void;
    vi.mocked(resourceApi.get).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const change = vi.fn(); const view = render(<ZeroValueConfirmation def={def} values={{ ...values, unitPrice: 1 }} enabled onChange={change}/>);
    expect(screen.queryByRole('button')).toBeNull(); expect(resourceApi.get).not.toHaveBeenCalled();
    view.rerender(<ZeroValueConfirmation def={def} values={values} enabled onChange={change}/>);
    await waitFor(() => expect(resourceApi.get).toHaveBeenCalledTimes(2));
    auth.companyId = 2; view.rerender(<ZeroValueConfirmation def={def} values={values} enabled onChange={change}/>);
    await waitFor(() => expect(screen.getByRole('button', { name: '确认该项为0' })).toHaveProperty('disabled', false));
    await act(async () => { finish(row('旧公司单位')); });
    fireEvent.click(screen.getByRole('button', { name: '确认该项为0' }));
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ zeroCostConfirmation: { reason: '赠', context: JSON.stringify(['合成装袋', '元/袋', '包装']) } }));
  });
});
