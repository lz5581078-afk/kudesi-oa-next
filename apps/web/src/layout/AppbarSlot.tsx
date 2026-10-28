import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * 顶栏页面标题旁的“插槽”：页面可以把说明（小问号）放到标题旁，不再自己占一行写大标题和描述。
 * `bare` 让顶栏只显示页面标题一处，不再叠一行分区名（页面已经在自己的分区里，位置信息只留一处）。
 */
type AppbarContextValue = { slot: HTMLElement | null; setBare: (bare: boolean) => void };
export const AppbarContext = createContext<AppbarContextValue | null>(null);

export function useAppbarState() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [bare, setBare] = useState(false);
  const value = useMemo(() => ({ slot, setBare }), [slot]);
  return { slot, setSlot, bare, setBare, value };
}

/** 声明这个页面在顶栏里只显示一处位置信息（页面标题），离开页面自动恢复。 */
export function useAppbarBare(enabled = true) {
  const ctx = useContext(AppbarContext);
  const setBare = ctx?.setBare;
  useEffect(() => {
    if (!enabled) return;
    setBare?.(true);
    return () => setBare?.(false);
  }, [setBare, enabled]);
}

/** 渲染到顶栏标题旁；没有顶栏（单独渲染、测试）时返回 false，由调用方放到别处。 */
export function useHasAppbarSlot(): boolean {
  return Boolean(useContext(AppbarContext)?.slot);
}

export function AppbarHint({ children }: { children: ReactNode }) {
  const ctx = useContext(AppbarContext);
  return ctx?.slot ? createPortal(children, ctx.slot) : null;
}
