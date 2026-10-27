import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { LicenseRecognizeButton } from './LicenseRecognize';

const png = () => new File(['x'], 'a.png', { type: 'image/png' });

describe('营业执照识别：拖图、粘贴、剪贴板', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('拖入图片即识别并弹出结果等确认', async () => {
    const rec = vi.spyOn(resourceApi, 'recognizeLicense').mockResolvedValue({ fields: { companyName: '甲公司' }, warnings: [] } as never);
    const { container } = render(<LicenseRecognizeButton onApply={() => undefined} />);
    fireEvent.drop(container.querySelector('.recognize')!, { dataTransfer: { files: [png()], types: ['Files'] } });
    expect(await screen.findByText('甲公司')).toBeTruthy();
    expect(rec).toHaveBeenCalledTimes(1);
  });
  it('Ctrl+V 粘贴截图识别；输入框里粘贴不接管', async () => {
    const rec = vi.spyOn(resourceApi, 'recognizeLicense').mockResolvedValue({ fields: { companyName: '乙公司' }, warnings: [] } as never);
    render(<><input aria-label="x" /><LicenseRecognizeButton onApply={() => undefined} /></>);
    screen.getByLabelText('x').focus();
    const e1 = createEvent.paste(window, { clipboardData: { files: [png()] } });
    window.dispatchEvent(e1);
    expect(rec).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    window.dispatchEvent(createEvent.paste(window, { clipboardData: { files: [png()] } }));
    await waitFor(() => expect(rec).toHaveBeenCalledTimes(1));
  });
  it('读取剪贴板图片；没有图片时提示', async () => {
    const rec = vi.spyOn(resourceApi, 'recognizeLicense').mockResolvedValue({ fields: { companyName: '丙公司' }, warnings: [] } as never);
    const read = vi.fn().mockResolvedValueOnce([{ types: ['text/plain'], getType: async () => new Blob() }])
      .mockResolvedValueOnce([{ types: ['image/png'], getType: async () => new Blob(['x'], { type: 'image/png' }) }]);
    Object.assign(navigator, { clipboard: { read } });
    render(<LicenseRecognizeButton onApply={() => undefined} />);
    fireEvent.click(screen.getByText('读取剪贴板图片'));
    expect(await screen.findByText(/剪贴板里没有图片/)).toBeTruthy();
    fireEvent.click(screen.getByText('读取剪贴板图片'));
    await waitFor(() => expect(rec).toHaveBeenCalledTimes(1));
  });
});
