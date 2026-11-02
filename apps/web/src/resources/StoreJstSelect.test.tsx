import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { StoreJstBadge, StoreJstSelect } from './StoreJstSelect';
import { resourceApi } from './api';
import { FieldInput } from './RecordForm';
import { getResourceDef } from '@kudesi/shared';

const shops = [{ id: '123', name: '甲店', platform: '淘宝' }, { id: '456', name: '乙店', platform: '抖音' }];
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('从公司聚水潭店铺中搜索、选择和解除关联', async () => {
  vi.spyOn(resourceApi, 'jushuitanShops').mockResolvedValue(shops);
  const changed = vi.fn();
  function Form() { const [value, set] = useState(''); return <StoreJstSelect value={value} onChange={v => { set(v); changed(v); }} />; }
  render(<Form />);
  expect(await screen.findByRole('option', { name: '甲店（123）' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('搜索聚水潭店铺'), { target: { value: '乙' } });
  expect(screen.queryByRole('option', { name: '甲店（123）' })).toBeNull();
  fireEvent.change(screen.getByLabelText('聚水潭店铺关联'), { target: { value: '456' } });
  expect(changed).toHaveBeenLastCalledWith('456');
  fireEvent.change(screen.getByLabelText('聚水潭店铺关联'), { target: { value: '' } });
  expect(changed).toHaveBeenLastCalledWith('');
});
it('失败保留历史关联，显示错误且可重试，不能把失败当成未关联', async () => {
  const query = vi.spyOn(resourceApi, 'jushuitanShops').mockRejectedValueOnce(new Error('授权已过期')).mockResolvedValue(shops);
  const changed = vi.fn();
  render(<StoreJstSelect value="old" currentName="历史店铺" onChange={changed} />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('授权已过期'));
  expect((screen.getByLabelText('聚水潭店铺关联') as HTMLSelectElement).value).toBe('old');
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
  expect(await screen.findByRole('option', { name: '甲店（123）' })).toBeTruthy();
  expect(query).toHaveBeenCalledTimes(2);
});
it('通用店铺表单使用店铺选择器', async () => {
  vi.spyOn(resourceApi, 'jushuitanShops').mockResolvedValue(shops);
  render(<FieldInput type="stores" field={getResourceDef('stores')!.fields.find(f => f.key === 'jushuitanShopId')!} value="123" onChange={vi.fn()} known={{}} onKnown={vi.fn()} />);
  await waitFor(() => expect((screen.getByLabelText('聚水潭店铺关联') as HTMLSelectElement).value).toBe('123'));
});
it('绿色显示已关联名称，黄色显示未关联；历史只有编号也可查看', () => {
  render(<><StoreJstBadge data={{ jushuitanShopId: '123', jushuitanShopName: '甲店' }} /><StoreJstBadge data={{}} /><StoreJstBadge data={{ jushuitanShopId: '456' }} /></>);
  expect(screen.getByText('已关联 · 甲店').classList.contains('ok')).toBe(true);
  expect(screen.getByText('未关联').classList.contains('warn')).toBe(true);
  expect(screen.getByText('已关联 · 456')).toBeTruthy();
});

it('表格编辑弹窗提交店铺编号，取消时不修改', async () => {
  vi.spyOn(resourceApi, 'jushuitanShops').mockResolvedValue(shops);
  const { CellEditor } = await import('./grid/CellEditor');
  const onCommit = vi.fn(), onCancel = vi.fn();
  const def = getResourceDef('stores')!, field = def.fields.find(f => f.key === 'jushuitanShopId')!;
  render(<CellEditor def={def} col={{ key: field.key, label: field.label, field, editable: true, kind: 'text' }} initial="" options={[]} onCommit={onCommit} onCancel={onCancel} />);
  await screen.findByRole('option', { name: '乙店（456）' });
  fireEvent.change(screen.getByLabelText('聚水潭店铺关联'), { target: { value: '456' } });
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
  expect(onCommit).toHaveBeenCalledWith({ value: '456' }, 'none');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
