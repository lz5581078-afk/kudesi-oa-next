import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ImageCropDialog, cropGeometry } from './ImageCropDialog';
import { FilesInput } from './FilesField';
import { PhoneUploadPage } from './PhoneUploadPage';
import { resourceApi, phoneUploadApi, type FileInfo } from './api';
const original = new File(['original-source'], '原照片.png', {
  type: 'image/png',
});
const field = {
  key: 'photo',
  label: '人员照片',
  type: 'files' as const,
  group: '人员照片',
  maxFiles: 1,
  accept: 'image' as const,
  phoneUpload: true,
  imageCrop: 'square' as const,
};
const fileInfo = {
  id: 11,
  name: '原照片-裁剪.jpg',
  mime: 'image/jpeg',
  size: 20,
};
beforeEach(() => {
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 800;
      naturalHeight = 400;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:test-photo');
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
    (callback, type) =>
      callback(new Blob(['cropped-jpeg'], { type: type ?? 'image/jpeg' })),
  );
  vi.spyOn(resourceApi, 'uploadFile').mockResolvedValue(fileInfo);
  vi.spyOn(resourceApi, 'fileUrl').mockResolvedValue({
    url: 'https://test.invalid/p.jpg',
    name: fileInfo.name,
    mime: fileInfo.mime,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = '';
});
it('宽图、长图及旋转后裁剪均覆盖方框，拖动不能越界留白', () => {
  expect(cropGeometry(800, 400, 280, 1, 0, 999, 999)).toMatchObject({
    scale: 0.7,
    x: 140,
    y: 0,
  });
  expect(cropGeometry(400, 800, 280, 1, 0, -999, -999)).toMatchObject({
    x: 0,
    y: -140,
  });
  expect(cropGeometry(800, 400, 280, 1, 90, 999, 999)).toMatchObject({
    x: 0,
    y: 140,
  });
  expect(cropGeometry(800, 400, 280, 2, 0, 999, 999)).toMatchObject({
    x: 420,
    y: 140,
  });
});
it('档案选图先裁剪，取消不上传；确认只上传裁剪后的JPEG并绑定单张值', async () => {
  function Form() {
    const [value, setValue] = useState<number[]>([]),
      [known, setKnown] = useState<Record<number, FileInfo>>({});
    return (
      <>
        <FilesInput
          field={field}
          type="workforce"
          value={value}
          known={known}
          onChange={setValue}
          onKnown={(f) => setKnown((x) => ({ ...x, [f.id]: f }))}
        />
        <output aria-label="已选照片">{value.join(',')}</output>
      </>
    );
  }
  render(<Form />);
  fireEvent.change(screen.getByLabelText('上传人员照片'), {
    target: { files: [original] },
  });
  await screen.findByRole('img', { name: '待裁剪照片' });
  expect(resourceApi.uploadFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(resourceApi.uploadFile).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('上传人员照片'), {
    target: { files: [original] },
  });
  await screen.findByRole('img', { name: '待裁剪照片' });
  fireEvent.click(screen.getByRole('button', { name: '旋转90°' }));
  fireEvent.change(screen.getByRole('slider', { name: '缩放' }), {
    target: { value: '1.5' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认裁剪并上传' }));
  await waitFor(() =>
    expect(screen.getByLabelText('已选照片').textContent).toBe('11'),
  );
  const args = vi.mocked(resourceApi.uploadFile).mock.calls[0];
  expect(args.slice(0, 2)).toEqual(['workforce', 'photo']);
  expect(args[2]).not.toBe(original);
  expect(args[2].type).toBe('image/jpeg');
  expect(args[2].name).toContain('裁剪.jpg');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('手机扫码收到裁剪要求后先裁剪，成功后次数归零且不能多选', async () => {
  window.location.hash = 'T'.repeat(43);
  vi.spyOn(phoneUploadApi, 'inspect').mockResolvedValue({
    label: '人员照片',
    resource: '兼职与临时工',
    remaining: 1,
    expiresAt: '',
    imageCrop: 'square',
  });
  const upload = vi
    .spyOn(phoneUploadApi, 'upload')
    .mockResolvedValue({ ok: true, remaining: 0 });
  render(<PhoneUploadPage />);
  await screen.findByText(/还能传 1 张/);
  const input = screen.getByLabelText('从相册选图') as HTMLInputElement;
  expect(input.multiple).toBe(false);
  fireEvent.change(input, { target: { files: [original] } });
  await screen.findByRole('img', { name: '待裁剪照片' });
  expect(upload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认裁剪并上传' }));
  await screen.findByText(/已上传：.*裁剪.jpg/);
  expect(upload.mock.calls[0][1].type).toBe('image/jpeg');
  expect(
    (screen.getByRole('button', { name: '从相册选择' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('裁剪上传失败保留照片和错误，可重试，不误报成功', async () => {
  const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('网络上传失败'))
      .mockResolvedValue(undefined),
    close = vi.fn();
  render(
    <ImageCropDialog file={original} onConfirm={upload} onClose={close} />,
  );
  await screen.findByRole('img', { name: '待裁剪照片' });
  fireEvent.click(screen.getByRole('button', { name: '确认裁剪并上传' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    '网络上传失败',
  );
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('img', { name: '待裁剪照片' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认裁剪并上传' }));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
});
it('上传中按Escape不会关闭裁剪或触发外层档案关闭', async () => {
  let finish!: () => void;
  const upload = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn(),
    outerKey = vi.fn();
  render(
    <div onKeyDown={outerKey}>
      <ImageCropDialog file={original} onConfirm={upload} onClose={close} />
    </div>,
  );
  await screen.findByRole('img', { name: '待裁剪照片' });
  fireEvent.click(screen.getByRole('button', { name: '确认裁剪并上传' }));
  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  expect(outerKey).not.toHaveBeenCalled();
  finish();
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: '确认裁剪并上传',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
});
