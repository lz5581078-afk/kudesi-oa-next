import { useEffect, useState } from 'react';

/** 手机宽度：和样式里的 720px 断点一致。没有 matchMedia（测试环境）时按电脑处理。 */
export const MOBILE_QUERY = '(max-width: 720px)';

export function useMediaQuery(query: string): boolean {
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [match, setMatch] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, [query]);
  return match;
}

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY);
