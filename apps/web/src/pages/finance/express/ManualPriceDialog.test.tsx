import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualPriceDialog } from './ManualPriceDialog';
import { expressApi } from './expressApi';
vi.mock('./expressApi', () => ({ expressApi: { saveRules: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('按省份手工创建快递价格表', () => {
  it('同省同重量的独立规则不合并，修改金额和备注后一次确认并采用手工来源', async () => {
    vi.mocked(expressApi.saveRules).mockResolvedValue({ created: 2, removed: 2 });
    const done = vi.fn();
    render(<ManualPriceDialog versionId={4} rules={[{ province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 300, note: '第一条' }, { province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 400, note: '第二条' }]} onClose={vi.fn()} onSaved={done} />);
    const second = within(screen.getByRole('group', { name: '广东第2条规则' }));
    fireEvent.change(second.getByLabelText('区间统一价'), { target: { value: '4.25' } });
    fireEvent.change(second.getByLabelText('备注'), { target: { value: '第二条保留' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成手工价格表' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(expressApi.saveRules).toHaveBeenCalledWith(4, 'manual', [expect.objectContaining({ fixedPrice: 300, note: '第一条' }), expect.objectContaining({ fixedPrice: 425, note: '第二条保留' })], true);
  });
  it('每省可加区间和公式，未完整填写拦截，删除空白条后0公斤首重公式保持0', async () => {
    vi.mocked(expressApi.saveRules).mockResolvedValue({ created: 1, removed: 0 });
    render(<ManualPriceDialog versionId={4} rules={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    const province = within(screen.getByRole('region', { name: '广东规则' }));
    fireEvent.click(province.getByRole('button', { name: '加首重续重' }));
    const rule = within(screen.getByRole('group', { name: '广东第1条规则' }));
    fireEvent.change(rule.getByLabelText('起始重量 kg'), { target: { value: '7.01' } });
    fireEvent.click(screen.getByRole('button', { name: '确认生成手工价格表' }));
    expect((await screen.findByRole('alert')).textContent).toContain('完整');
    expect(expressApi.saveRules).not.toHaveBeenCalled();
    fireEvent.change(rule.getByLabelText('首重类型'), { target: { value: '0' } });
    fireEvent.change(rule.getByLabelText('首重金额'), { target: { value: '3.50' } });
    fireEvent.change(rule.getByLabelText('续重/公斤'), { target: { value: '0.50' } });
    fireEvent.click(province.getByRole('button', { name: '加区间统一价' }));
    fireEvent.click(within(screen.getByRole('group', { name: '广东第2条规则' })).getByRole('button', { name: '删除规则' }));
    fireEvent.click(screen.getByRole('button', { name: '确认生成手工价格表' }));
    await waitFor(() => expect(expressApi.saveRules).toHaveBeenCalledWith(4, 'manual', [expect.objectContaining({ province: '广东', shipWeightMin: 7.01, shipWeightMax: null, firstWeight: 0, firstPrice: 350, extraPrice: 50, fixedPrice: null })], true));
  });
});
