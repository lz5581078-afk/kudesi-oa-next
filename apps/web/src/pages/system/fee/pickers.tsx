import { useEffect, useRef, useState } from 'react';
import { feeApi } from './feeApi';

/**
 * 主卡选择：只列“主卡”（没有主卡的启用号码），不含自己；主子卡只有两级，子卡不会出现在这里。
 * 清空 = 设为主卡（不挂在任何主卡下）。
 */
export function MainCardPick({ value, label, excludeId, onChange }: { value: number | null; label: string; excludeId?: number; onChange: (id: number | null, label: string) => void }) {
  const [text, setText] = useState(label);
  const [items, setItems] = useState<Array<{ id: number; number: string; children: number }>>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { setText(label); }, [label, value]);
  const search = (kw: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      feeApi.ledger({ view: 'main', q: kw, pageSize: 10 })
        .then((r) => setItems((r.groups ?? []).filter((g) => g.main.id !== excludeId).map((g) => ({ id: g.main.id, number: g.main.number, children: g.children.length }))))
        .catch(() => setItems([]));
    }, 200);
  };
  return (
    <div className="pick fee-pick">
      <input
        aria-label="主卡号" value={text} placeholder="输入号码搜索主卡；留空 = 设为主卡"
        onFocus={() => { setOpen(true); search(text); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setText(e.target.value); setOpen(true); search(e.target.value); if (value !== null) onChange(null, ''); }}
      />
      {open && (
        <ul className="pick-list" role="listbox">
          {items.length === 0 && <li className="muted">没有可选的主卡</li>}
          {items.map((i) => (
            <li key={i.id}><button type="button" role="option" aria-selected={i.id === value} onMouseDown={(e) => e.preventDefault()} onClick={() => { setText(i.number); onChange(i.id, i.number); setOpen(false); }}>{i.number}<span className="muted"> · 已挂 {i.children} 张子卡</span></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
