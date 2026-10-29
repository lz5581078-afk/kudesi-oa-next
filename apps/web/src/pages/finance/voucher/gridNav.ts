import type { KeyboardEvent } from 'react';

const FIELDS = 'input:not([disabled]):not([type="hidden"]):not([readonly]), select:not([disabled])';

/**
 * 明细网格的键盘录入（管家婆单据习惯）：
 * 回车 → 同一行下一格，行尾回车 → 下一行第一格，最后一行行尾回车 → 加一行并回到它的第一格；
 * 上/下方向键 → 同一列上/下一行（下拉框除外，保留它自己的选项切换）；Shift+Delete → 删除当前行。
 */
export function gridKeyDown(e: KeyboardEvent<HTMLElement>, opts: { addRow?: () => void; deleteRow?: (row: number) => void }) {
  const target = e.target as HTMLElement;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  const tr = target.closest('tr[data-row]') as HTMLElement | null;
  const body = tr?.parentElement;
  if (!tr || !body) return;
  const rows = Array.from(body.querySelectorAll<HTMLElement>(':scope > tr[data-row]'));
  const r = rows.indexOf(tr);
  const cells = Array.from(tr.querySelectorAll<HTMLElement>(FIELDS));
  const c = cells.indexOf(target);
  const focusAt = (row: number, col: number) => {
    const list = Array.from(rows[row]?.querySelectorAll<HTMLElement>(FIELDS) ?? []);
    const el = list[Math.min(col, list.length - 1)];
    el?.focus();
    if (el instanceof HTMLInputElement && el.type !== 'date') el.select?.();
  };
  if (e.key === 'Delete' && e.shiftKey && opts.deleteRow) { e.preventDefault(); opts.deleteRow(r); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey) {
    e.preventDefault();
    if (c < cells.length - 1) { cells[c + 1].focus(); (cells[c + 1] as HTMLInputElement).select?.(); return; }
    if (r < rows.length - 1) { focusAt(r + 1, 0); return; }
    if (opts.addRow) { opts.addRow(); setTimeout(() => { const now = Array.from(body.querySelectorAll<HTMLElement>(':scope > tr[data-row]')); const last = now[now.length - 1]; (last?.querySelector<HTMLElement>(FIELDS))?.focus(); }, 0); }
    return;
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && target instanceof HTMLInputElement && !e.altKey) {
    const to = r + (e.key === 'ArrowDown' ? 1 : -1);
    if (to >= 0 && to < rows.length) { e.preventDefault(); focusAt(to, c); }
  }
}
