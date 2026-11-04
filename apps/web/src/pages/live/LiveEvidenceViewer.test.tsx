import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveEvidenceViewer } from './LiveEvidenceViewer';

let resize: () => void;
const disconnect = vi.fn();
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(720);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function loadedImage() {
  const image = screen.getByRole('img', {name:'直播后台.png'}) as HTMLImageElement;
  Object.defineProperties(image, {naturalWidth:{value:2400},naturalHeight:{value:900}});
  fireEvent.load(image);
  return image;
}
it('宽图默认保持原始像素尺寸，放大与还原同时保留长宽比', () => {
  render(<LiveEvidenceViewer url="/original.png" name="直播后台.png" onClose={()=>{}}/>);
  const image = loadedImage();
  expect(image.style.width).toBe('2400px'); expect(image.style.height).toBe('900px');
  fireEvent.click(screen.getByRole('button',{name:'放大图片'}));
  expect(image.style.width).toBe('3000px'); expect(image.style.height).toBe('1125px');
  fireEvent.click(screen.getByRole('button',{name:'原始尺寸'}));
  expect(image.style.width).toBe('2400px'); expect(screen.getByLabelText('图片缩放比例').textContent).toBe('100%');
});
it('适应窗口按图片比例完整显示，窗口变窄后重新适配，仍可回到原始尺寸', () => {
  render(<LiveEvidenceViewer url="/original.png" name="直播后台.png" onClose={()=>{}}/>);
  const image = loadedImage();
  fireEvent.click(screen.getByRole('button',{name:'适应窗口'}));
  expect(image.style.width).toBe('720px'); expect(image.style.height).toBe('270px');
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(360);
  act(()=>resize());
  expect(image.style.width).toBe('360px'); expect(image.style.height).toBe('135px');
  fireEvent.click(screen.getByRole('button',{name:'原始尺寸'}));
  expect(image.style.width).toBe('2400px');
});
it('直接原图链接保留原地址，加载失败有提示，关闭后释放窗口观察', () => {
  const close=vi.fn();
  const view=render(<LiveEvidenceViewer url="/original.png?signature=test" name="直播后台.png" onClose={close}/>);
  const link=screen.getByRole('link',{name:'查看原图'});
  expect(link.getAttribute('href')).toBe('/original.png?signature=test'); expect(link.getAttribute('target')).toBe('_blank');
  fireEvent.error(screen.getByRole('img',{name:'直播后台.png'}));
  expect(screen.getByRole('alert').textContent).toContain('图片加载失败');
  fireEvent.click(screen.getByRole('button',{name:'关闭'}));expect(close).toHaveBeenCalledTimes(1);
  view.unmount();expect(disconnect).toHaveBeenCalledTimes(1);
});
