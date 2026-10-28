import { useEffect, useState } from 'react';

/**
 * 表格编辑只在电脑宽屏提供：手机和窄屏没有键盘、也放不下网格，粘贴/拖拽/多格选择都不好用，
 * 窄屏上不显示“表格编辑”按钮，请用电脑编辑（手机上仍可用详情抽屉里的表单逐条改）。
 */
export const GRID_MIN_WIDTH = 861;

export function useWideScreen(): boolean {
  const query = `(min-width: ${GRID_MIN_WIDTH}px)`;
  const read = () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true);
  const [wide, setWide] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, [query]);
  return wide;
}
