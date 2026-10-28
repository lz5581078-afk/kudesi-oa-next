import { useCallback, useState } from 'react';
import type { FieldDef } from '@kudesi/shared';

/** 行密度：紧凑一屏多看几行，舒适留白多一些；全站资料列表共用一个选择并记住。 */
export type Density = 'compact' | 'comfortable';
const DENSITY_KEY = 'kudesi.list.density';

export function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'comfortable' ? 'comfortable' : 'compact';
  } catch {
    return 'compact';
  }
}

export function useDensity() {
  const [density, set] = useState<Density>(readDensity);
  const update = useCallback((next: Density) => {
    set(next);
    try {
      localStorage.setItem(DENSITY_KEY, next);
    } catch {
      /* 存储不可用时只是不记住 */
    }
  }, []);
  return [density, update] as const;
}

const WIDTH_MIN = 64;
const WIDTH_MAX = 640;
const widthKey = (type: string) => `kudesi.colw.${type}`;

function readWidths(type: string): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(widthKey(type)) ?? 'null') as Record<string, number> | null;
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number' && n >= WIDTH_MIN && n <= WIDTH_MAX));
  } catch {
    return {};
  }
}

/** 列宽（拖表头右边缘调整），按资料类型记住；双击边缘恢复默认。 */
export function useColumnWidths(type: string) {
  const [state, setState] = useState<{ type: string; widths: Record<string, number> }>(() => ({ type, widths: readWidths(type) }));
  const widths = state.type === type ? state.widths : readWidths(type);
  const persist = useCallback((next: Record<string, number>) => {
    try {
      localStorage.setItem(widthKey(type), JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  }, [type]);
  /** 拖动中只改界面，松手才 commit 写入本地 */
  const preview = useCallback((key: string, w: number) => {
    setState((cur) => ({ type, widths: { ...(cur.type === type ? cur.widths : readWidths(type)), [key]: Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(w))) } }));
  }, [type]);
  const commit = useCallback(() => setState((cur) => { persist(cur.widths); return cur; }), [persist]);
  const reset = useCallback((key: string) => {
    setState((cur) => {
      const next = { ...(cur.type === type ? cur.widths : readWidths(type)) };
      delete next[key];
      persist(next);
      return { type, widths: next };
    });
  }, [type, persist]);
  return { widths, preview, commit, reset };
}

const CJK = /[　-鿿＀-￯]/;
export const textWidth = (s: string) => [...s].reduce((n, c) => n + (CJK.test(c) ? 14 : 7.6), 0);

/** 没有手动调过时的默认列宽：按字段类型给个合适的宽度，表头文字一定放得下。 */
export function defaultColWidth(f: FieldDef): number {
  const base: Record<string, number> = { text: 150, textarea: 220, number: 96, decimal: 96, money: 104, date: 112, monthday: 104, select: 112, ref: 160, refs: 180, phone: 128, bool: 80, files: 110, attrs: 160, sensitive: 150 };
  const head = textWidth(f.label) + 52; // 左右留白 + 排序箭头
  return Math.max(base[f.type] ?? 130, head);
}

/** 按当前这批数据里最长的内容估一个舒服的列宽（不超过 360），没有手动调过的列用它，免得名称、代码一上来就被截断。 */
export function autoColWidth(f: FieldDef, texts: string[], extra = 0): number {
  const floor = defaultColWidth(f);
  const longest = texts.slice(0, 60).reduce((n, t) => Math.max(n, textWidth(t)), 0);
  return Math.min(f.type === 'textarea' ? 260 : 360, Math.max(floor, Math.ceil(longest + 26 + extra)));
}
