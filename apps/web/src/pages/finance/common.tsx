import { useEffect, useRef, useState } from 'react';
import { resourceApi } from '../../resources/api';

/** 元（文本）→ 分；空串 → null；非法 → NaN */
export function yuanToCents(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
export const centsToYuan = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
export const money = (c: number | null | undefined) => (c === null || c === undefined ? '—' : `¥${(c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export const DOC_STATUS_TONE: Record<string, string> = { draft: 'muted', issued: 'warn', posted: 'ok', reversed: 'bad' };

/** 搜索式选择：输入关键字，从资料里找；用于商品、客户、费用项目等可能很多的资料。 */
export function SearchPick({ type, value, label, onChange, placeholder, fieldKey, fieldValue, ariaLabel }: {
  type: string; value: number | null | undefined; label?: string; onChange: (id: number | null, label: string) => void;
  placeholder?: string; fieldKey?: string; fieldValue?: string; ariaLabel?: string;
}) {
  const [text, setText] = useState(label ?? '');
  const [items, setItems] = useState<Array<{ id: number; title: string }>>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { setText(label ?? ''); }, [label, value]);
  const search = (kw: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      resourceApi.list(type, { keyword: kw, pageSize: 15, fieldKey, fieldValue }).then((r) => setItems(r.items.filter((i) => i.status !== 'inactive' && i.status !== 'deleted').map((i) => ({ id: i.id, title: i.title })))).catch(() => setItems([]));
    }, 200);
  };
  return (
    <div className="pick">
      <input
        aria-label={ariaLabel} value={text} placeholder={placeholder ?? '输入名称搜索'}
        onFocus={() => { setOpen(true); search(''); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setText(e.target.value); setOpen(true); search(e.target.value); if (value) onChange(null, ''); }}
      />
      {open && (
        <ul className="pick-list" role="listbox">
          {items.length === 0 && <li className="muted">没有找到</li>}
          {items.map((i) => (
            <li key={i.id}><button type="button" role="option" aria-selected={i.id === value} onMouseDown={(e) => e.preventDefault()} onClick={() => { setText(i.title); onChange(i.id, i.title); setOpen(false); }}>{i.title}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="row-actions">
      <span className="muted">共 {total} 条</span>
      <button type="button" className="secondary-button small" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span>{page} / {pages}</span>
      <button type="button" className="secondary-button small" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button>
    </div>
  );
}

/** 利润率（百分数，最多 6 位小数）显示：12.345678 → "12.345678%"，没设置 → "未设置" */
export const pct = (p: number | null | undefined) => (p === null || p === undefined ? '未设置' : `${Number(p.toFixed(6))}%`);
