import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoucherPanel } from './VoucherPanel';
import { sessionApi, type VoucherFile } from './sessionApi';

vi.mock('./sessionApi', () => ({
  sessionApi: { uploadVoucher: vi.fn(), capture: vi.fn(), requestStatus: vi.fn(), voucherUrl: vi.fn() },
}));
const m = vi.mocked(sessionApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const f = (id: number, name = `凭证${id}.png`): VoucherFile => ({ id, name, mime: 'image/png', size: 2048 });
function Host({ initial = [] as VoucherFile[], shopId = 5 as number | null, onChange = vi.fn() }) {
  const [files, setFiles] = useState(initial);
  return <VoucherPanel files={files} shopId={shopId} onChange={(x) => { setFiles(x); onChange(x); }} />;
}

describe('提现凭证面板', () => {
  it('上传文件后出现在列表里，可以移除', async () => {
    m.uploadVoucher.mockResolvedValue(f(1, '回单.png'));
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    const file = new File([new Uint8Array([1, 2, 3])], '回单.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('选择凭证文件'), { target: { files: [file] } });
    await screen.findByText(/回单\.png/);
    expect(m.uploadVoucher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(screen.queryByText(/回单\.png/)).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('粘贴截图直接上传；非图片的粘贴内容忽略', async () => {
    m.uploadVoucher.mockResolvedValue(f(2, 'image.png'));
    render(<Host />);
    const panel = screen.getByLabelText('提现凭证');
    fireEvent.paste(panel, { clipboardData: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } });
    expect(m.uploadVoucher).not.toHaveBeenCalled();
    fireEvent.paste(panel, { clipboardData: { files: [new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })] } });
    await screen.findByText(/image\.png/);
    expect(m.uploadVoucher).toHaveBeenCalledTimes(1);
  });

  it('从店铺窗口截图：通知助手 → 轮询到成功 → 加入列表；失败时显示原因', async () => {
    m.capture.mockResolvedValue({ id: 9 });
    m.requestStatus.mockResolvedValueOnce({ id: 9, kind: 'capture', status: 'claimed', errorText: null, file: null }).mockResolvedValueOnce({ id: 9, kind: 'capture', status: 'succeeded', errorText: null, file: f(3, '店铺截图.png') });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: '从店铺窗口截图' }));
    await waitFor(() => expect(screen.getByText(/店铺截图\.png/)).toBeTruthy(), { timeout: 6000 });
    expect(m.capture).toHaveBeenCalledWith(5);

    m.capture.mockResolvedValue({ id: 10 });
    m.requestStatus.mockResolvedValue({ id: 10, kind: 'capture', status: 'failed', errorText: '这家店铺的窗口没有打开', file: null });
    fireEvent.click(screen.getByRole('button', { name: '从店铺窗口截图' }));
    expect((await screen.findByRole('alert', {}, { timeout: 4000 })).textContent).toContain('窗口没有打开');
  }, 15000);

  it('没有店铺登录记录时不显示截图按钮；只读模式不能上传和移除；超过 10 个拒绝', async () => {
    const { unmount } = render(<Host shopId={null} />);
    expect(screen.queryByRole('button', { name: '从店铺窗口截图' })).toBeNull();
    unmount();
    render(<VoucherPanel files={[f(1)]} readOnly />);
    expect(screen.queryByRole('button', { name: '上传图片/PDF' })).toBeNull();
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull();
    expect(screen.getByRole('button', { name: '查看' })).toBeTruthy();
    cleanup();
    render(<Host initial={Array.from({ length: 10 }, (_, i) => f(i + 1))} />);
    fireEvent.change(screen.getByLabelText('选择凭证文件'), { target: { files: [new File(['x'], 'b.png', { type: 'image/png' })] } });
    expect((await screen.findByRole('alert')).textContent).toContain('最多 10');
    expect(m.uploadVoucher).not.toHaveBeenCalled();
  });
});
