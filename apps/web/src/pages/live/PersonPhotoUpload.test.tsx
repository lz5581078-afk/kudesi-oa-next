import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PersonPhotoUpload } from './PersonPhotoUpload';
import { resourceApi } from '../../resources/api';
vi.mock('../../resources/ImageCropDialog', () => ({
  ImageCropDialog: ({ onConfirm, onClose }: any) => (
    <div role="dialog" aria-label="裁剪">
      <button
        onClick={() =>
          onConfirm(new File(['crop'], '裁剪.jpg', { type: 'image/jpeg' }))
        }
      >
        确认裁剪
      </button>
      <button onClick={onClose}>取消裁剪</button>
    </div>
  ),
}));
vi.mock('../../resources/PhoneUploadDialog', () => ({
  PhoneUploadDialog: ({ inline, onFiles }: any) => (
    <button
      data-inline={String(inline)}
      onClick={() =>
        onFiles([{ id: 22, name: '手机裁剪.jpg', mime: 'image/jpeg', size: 4 }])
      }
    >
      手机裁剪完成
    </button>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('电脑选图先裁剪再上传，自动仅保存照片字段', async () => {
  const upload = vi
    .spyOn(resourceApi, 'uploadFile')
    .mockResolvedValue({
      id: 21,
      name: '裁剪.jpg',
      mime: 'image/jpeg',
      size: 4,
    });
  const update = vi.spyOn(resourceApi, 'update').mockResolvedValue({} as never),
    saved = vi.fn();
  render(
    <PersonPhotoUpload recordId={8} onSaved={saved} onCropChange={vi.fn()} />,
  );
  fireEvent.change(screen.getByLabelText('选择人员照片'), {
    target: {
      files: [new File(['original'], '原图.png', { type: 'image/png' })],
    },
  });
  expect(upload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('确认裁剪'));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(upload.mock.calls[0][2].name).toBe('裁剪.jpg');
  expect(update).toHaveBeenCalledWith('workforce', 8, { photo: [21] });
});
it('扫码内嵌姓名浮层，保存失败可重试同一张照片，无需重传', async () => {
  const update = vi
      .spyOn(resourceApi, 'update')
      .mockRejectedValueOnce(new Error('保存失败'))
      .mockResolvedValue({} as never),
    saved = vi.fn();
  render(
    <PersonPhotoUpload recordId={9} onSaved={saved} onCropChange={vi.fn()} />,
  );
  fireEvent.click(screen.getByText('手机扫码'));
  expect(screen.getByText('手机裁剪完成').getAttribute('data-inline')).toBe(
    'true',
  );
  fireEvent.click(screen.getByText('手机裁剪完成'));
  await screen.findByRole('alert');
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('重试保存照片'));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(update).toHaveBeenNthCalledWith(2, 'workforce', 9, { photo: [22] });
});
