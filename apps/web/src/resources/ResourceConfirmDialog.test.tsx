import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { ReasonDialog } from './ResourceConfirmDialog';

afterEach(cleanup);

it('默认模式继续要求原因并保留常用原因选择', async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<ReasonDialog title="停用资料" confirmLabel="确认停用" onClose={vi.fn()} onConfirm={submit}/>);
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  expect(await screen.findByText('请填写原因（至少 2 个字）')).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重复录入' }));
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith('重复录入'));
});

it('纯确认没有原因字段，取消不写入；确认只发一次，失败保留窗口并可重试', async () => {
  const cancel = vi.fn(), submit = vi.fn(); let reject!: (error: Error) => void;
  submit.mockImplementationOnce(() => new Promise((_, no) => { reject = no; })).mockResolvedValueOnce(undefined);
  render(<ReasonDialog title="请确认操作" hint="合成删除确认" confirmLabel="确认" danger requireReason={false} onClose={cancel} onConfirm={submit}/>);
  expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('group', { name: '常用原因' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(cancel).toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认' })); fireEvent.click(screen.getByRole('button', { name: '确认' }));
  expect(submit).toHaveBeenCalledTimes(1); expect(submit).toHaveBeenCalledWith('');
  expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true);
  await act(async () => reject(new ApiError(409, '合成引用保护')));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '合成引用保护');
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
});
