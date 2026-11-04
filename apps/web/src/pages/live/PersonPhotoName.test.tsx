import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PersonPhotoName, personPhotoApi } from './PersonPhotoName';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('点击姓名才读取照片，使用人员编号且不触发场次行点击', async () => {
  const read = vi
      .spyOn(personPhotoApi, 'read')
      .mockResolvedValue({
        userId: 7,
        name: '同名主播',
        photo: {
          url: 'https://test.invalid/p.jpg',
          name: '照片.jpg',
          mime: 'image/jpeg',
          expiresIn: 300,
        },
      }),
    row = vi.fn();
  render(
    <div onClick={row}>
      <PersonPhotoName personId={7} name="同名主播" />
    </div>,
  );
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '查看同名主播资料' }));
  expect(
    (
      await screen.findByRole('img', { name: '同名主播的人员照片' })
    ).getAttribute('src'),
  ).toBe('https://test.invalid/p.jpg');
  expect(read).toHaveBeenCalledWith(7);
  expect(screen.getByRole('dialog').closest('.modal-backdrop')).toBeNull();
  expect(screen.getByRole('button', { name: '查看同名主播资料' }).getAttribute('aria-expanded')).toBe('true');
  expect(row).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(row).not.toHaveBeenCalled();
});
it('未上传明确提示，失败可重试且不会显示旧照片', async () => {
  const read = vi
    .spyOn(personPhotoApi, 'read')
    .mockRejectedValueOnce(new Error('读取失败'))
    .mockResolvedValue({ userId: 8, name: '主播乙', photo: null });
  render(<PersonPhotoName personId={8} name="主播乙" />);
  fireEvent.click(screen.getByRole('button', { name: '查看主播乙资料' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '重新读取照片' }));
  await screen.findByText(/尚未上传人员照片/);
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByText('电脑上传')).toBeNull();
});
it('缺少照片且有档案编辑权限时可原地补传，Escape关闭并回到姓名', async () => {
  vi.spyOn(personPhotoApi, 'read').mockResolvedValue({ userId: 7, name: '主播', photo: null, upload: { recordId: 77 } });
  render(<PersonPhotoName personId={7} name="主播" />);
  const name = screen.getByRole('button', { name: '查看主播资料' });
  fireEvent.click(name);
  await screen.findByText('电脑上传');
  expect(screen.getByText('手机扫码')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(name);
});
it('同名编号变化时不展示上个人照片，旧响应不能覆盖新人员', async () => {
  let resolve!: (x: any) => void;
  vi.spyOn(personPhotoApi, 'read').mockImplementation((id) =>
    id === 1
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve({ userId: 2, name: '同名', photo: null }),
  );
  const v = render(<PersonPhotoName personId={1} name="同名" />);
  fireEvent.click(screen.getByRole('button', { name: '查看同名资料' }));
  v.rerender(<PersonPhotoName personId={2} name="同名" />);
  await screen.findByText(/尚未上传人员照片/);
  resolve({
    userId: 1,
    name: '同名',
    photo: { url: 'old.jpg', name: 'old', mime: 'image/jpeg', expiresIn: 300 },
  });
  await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
});
