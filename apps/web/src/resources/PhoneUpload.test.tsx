import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const status = vi.fn();
const inspect = vi.fn();
const upload = vi.fn();
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, phoneUploadApi: { create: (...a: unknown[]) => create(...a), status: (...a: unknown[]) => status(...a), inspect: (...a: unknown[]) => inspect(...a), upload: (...a: unknown[]) => upload(...a) } };
});
import { PhoneUploadDialog } from './PhoneUploadDialog';
import { PhoneUploadPage } from './PhoneUploadPage';

const session = { id: 5, token: 'T'.repeat(43), expiresAt: '', minutes: 10, maxUploads: 10 };
beforeEach(() => {
  create.mockReset().mockResolvedValue(session);
  status.mockReset().mockResolvedValue({ scanned: false, uploaded: 0, expired: false, expiresAt: '', files: [] });
  inspect.mockReset();
  upload.mockReset();
});
afterEach(() => { cleanup(); window.location.hash = ''; });

describe('电脑端：手机上传二维码', () => {
  it('显示二维码和有效期；手机传上来的图只通知一次', async () => {
    const onFiles = vi.fn();
    status.mockResolvedValue({ scanned: true, uploaded: 1, expired: false, expiresAt: '', files: [{ id: 11, name: '正面.png', mime: 'image/png', size: 10 }] });
    render(<PhoneUploadDialog type="finance-products" field="photos" label="商品照片" onFiles={onFiles} onClose={() => undefined} />);
    await screen.findByRole('img', { name: '手机上传二维码' });
    expect(create).toHaveBeenCalledWith('finance-products', 'photos');
    expect(screen.getByText(/10 分钟内有效，最多 10 张/)).toBeTruthy();
    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    expect(onFiles.mock.calls[0][0].map((f: { id: number }) => f.id)).toEqual([11]);
    await screen.findByText('已收到 1 张');
  });

  it('二维码失效后可以重新生成', async () => {
    status.mockResolvedValue({ scanned: false, uploaded: 0, expired: true, expiresAt: '', files: [] });
    render(<PhoneUploadDialog type="finance-products" field="photos" label="商品照片" onFiles={() => undefined} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: '重新生成' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });

  it('没权限或字段不支持时给出原因，不显示二维码', async () => {
    const { ApiError } = await import('../api/client');
    create.mockRejectedValue(new ApiError(403, '没有权限执行此操作'));
    render(<PhoneUploadDialog type="finance-products" field="photos" label="商品照片" onFiles={() => undefined} onClose={() => undefined} />);
    await screen.findByText('没有权限执行此操作');
    expect(screen.queryByRole('img', { name: '手机上传二维码' })).toBeNull();
  });
});

describe('手机端页面', () => {
  it('网址里没有令牌：直接提示重新生成，不请求服务器', async () => {
    render(<PhoneUploadPage />);
    await screen.findByText(/二维码无效/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('令牌失效：显示服务器给的原因，没有上传按钮', async () => {
    const { ApiError } = await import('../api/client');
    window.location.hash = '#' + 'T'.repeat(43);
    inspect.mockRejectedValue(new ApiError(410, '二维码已失效，请在电脑上重新生成'));
    render(<PhoneUploadPage />);
    await screen.findByText('二维码已失效，请在电脑上重新生成');
    expect(screen.queryByRole('button', { name: '拍照上传' })).toBeNull();
  });

  it('选图后逐张上传，显示剩余张数；用完后按钮不可点', async () => {
    window.location.hash = '#' + 'T'.repeat(43);
    inspect.mockResolvedValue({ label: '商品照片', resource: '商品档案', remaining: 2 });
    upload.mockResolvedValueOnce({ ok: true, remaining: 1 }).mockResolvedValueOnce({ ok: true, remaining: 0 });
    render(<PhoneUploadPage />);
    await screen.findByText(/商品档案 · 商品照片，还能传 2 张/);
    const input = screen.getByLabelText('从相册选图');
    const f = (n: string) => new File([new Uint8Array([1, 2, 3])], n, { type: 'image/png' });
    fireEvent.change(input, { target: { files: [f('a.png'), f('b.png')] } });
    await screen.findByText('已上传：b.png');
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0][0]).toBe('T'.repeat(43));
    expect(screen.getByText(/还能传 0 张/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '拍照上传' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
