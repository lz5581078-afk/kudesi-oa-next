import { useCallback, useEffect, useRef, useState } from 'react';
import { todayInChina } from '@kudesi/shared';
import { CopyButton as SharedCopyButton } from '../../resources/CopyValue';

/** 财务页面共用的小工具：日期快捷区间、记住筛选条件、一键复制、导出 CSV、手机端判断。只做展示，不参与金额计算。 */

const addDays = (day: string, n: number) => { const t = new Date(`${day}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const monthStartOf = (day: string, offset = 0) => { const [y, m] = day.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + offset, 1)); return t.toISOString().slice(0, 10); };
const monthEndOf = (day: string, offset = 0) => addDays(monthStartOf(day, offset + 1), -1);

export interface DatePreset { key: string; label: string; range: () => [string, string] }
export const DATE_PRESETS: DatePreset[] = [
  { key: 'today', label: '今天', range: () => [todayInChina(), todayInChina()] },
  { key: '7d', label: '近7天', range: () => [addDays(todayInChina(), -6), todayInChina()] },
  { key: 'month', label: '本月', range: () => [monthStartOf(todayInChina()), todayInChina()] },
  { key: 'lastMonth', label: '上月', range: () => [monthStartOf(todayInChina(), -1), monthEndOf(todayInChina(), -1)] },
  { key: 'all', label: '全部', range: () => ['', ''] },
];

/** 当前开始/结束日期正好等于哪个快捷区间（没有则空串） */
export function activePreset(from: string, to: string): string {
  return DATE_PRESETS.find((p) => { const [a, b] = p.range(); return a === from && b === to; })?.key ?? '';
}

/** 日期快捷按钮：点一下就设好开始/结束日期。 */
export function DateChips({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const current = activePreset(from, to);
  return (
    <div className="chips" role="group" aria-label="日期范围快捷选择">
      {DATE_PRESETS.map((p) => (
        <button key={p.key} type="button" className={`chip${current === p.key ? ' active' : ''}`} aria-pressed={current === p.key} onClick={() => { const [a, b] = p.range(); onChange(a, b); }}>{p.label}</button>
      ))}
    </div>
  );
}

/** 读写浏览器里记住的筛选条件；浏览器禁止存储时静默退回默认值 */
export function readStored<T extends object>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
  } catch { return fallback; }
}
export function writeStored(key: string, value: object) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略 */ }
}
export function usePersisted<T extends object>(key: string | null, initial: T): [T, (patch: Partial<T> | ((cur: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (key ? readStored(key, initial) : initial));
  useEffect(() => { if (key) writeStored(key, value); }, [key, value]);
  const update = useCallback((patch: Partial<T> | ((cur: T) => T)) => setValue((cur) => (typeof patch === 'function' ? patch(cur) : { ...cur, ...patch })), []);
  return [value, update];
}

/** 复制统一用 resources/CopyValue；财务页保留 text 属性写法，内部直接转给它。 */
export { copyText } from '../../resources/CopyValue';
export function CopyButton({ text, label }: { text: string; label: string }) {
  return <SharedCopyButton value={text} label={label} />;
}

/** 手机端判断（窄屏换成卡片列表） */
export function useIsMobile(query = '(max-width: 720px)') {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const media = window.matchMedia(query);
    const on = () => setMatches(media.matches);
    on();
    media.addEventListener?.('change', on);
    return () => media.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}

/** 导出 CSV（带 BOM，Excel 直接打开不乱码） */
export function downloadCsv(fileName: string, head: string[], rows: Array<Array<string | number | null | undefined>>): boolean {
  const esc = (v: string | number | null | undefined) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = `﻿${[head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')}`;
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch { return false; }
}

/** 填了内容还没保存时，刷新或关闭浏览器前提醒一下 */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

/** 金额数字：元，保留两位，用于复制/导出（不带符号和千分位） */
export const plainYuan = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));
