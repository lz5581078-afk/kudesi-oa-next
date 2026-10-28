import { useEffect, useMemo, useRef, useState } from 'react';
import { PRESETS, normalizeKeys, presetKeys, type PickItem, type PresetId } from './columnPick';

interface Props {
  items: readonly PickItem[];
  picked: readonly string[];
  onChange: (keys: string[]) => void;
}

/** 表格自己的列选择器：按字段分组、可搜索、全选/按组勾选、预设；名称/编码固定显示 */
export function ColumnPicker({ items, picked, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const set = useMemo(() => new Set(picked), [picked]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const keyword = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const m = new Map<string, PickItem[]>();
    for (const i of items) {
      if (keyword && !i.label.toLowerCase().includes(keyword) && !i.key.toLowerCase().includes(keyword)) continue;
      m.set(i.group, [...(m.get(i.group) ?? []), i]);
    }
    return [...m.entries()];
  }, [items, keyword]);

  const set2 = (keys: Iterable<string>) => onChange(normalizeKeys(items, [...keys]));
  const toggle = (k: string, on: boolean) => { const n = new Set(set); if (on) n.add(k); else n.delete(k); set2(n); };
  const toggleGroup = (list: PickItem[], on: boolean) => { const n = new Set(set); for (const i of list) { if (on) n.add(i.key); else if (!i.fixed) n.delete(i.key); } set2(n); };

  return (
    <div className="grid-colpicker" ref={box}>
      <button type="button" className="secondary-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        列（{picked.length}/{items.length}）
      </button>
      {open && (
        <div className="grid-colpanel card" role="dialog" aria-label="选择表格列">
          <div className="grid-colpanel-head">
            <input type="search" aria-label="搜索列" placeholder="搜索字段名" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="pill-row">
              {PRESETS.map((p) => <button key={p.id} type="button" className="chip" title={p.hint} onClick={() => set2(presetKeys(items, p.id as PresetId))}>{p.label}</button>)}
              <button type="button" className="link-button" onClick={() => set2(items.map((i) => i.key))}>全选</button>
              <button type="button" className="link-button" onClick={() => set2([])}>清空</button>
            </div>
          </div>
          <div className="grid-colpanel-body">
            {groups.length === 0 && <p className="muted">没有匹配的字段</p>}
            {groups.map(([group, list]) => {
              const on = list.filter((i) => set.has(i.key)).length;
              return (
                <fieldset key={group}>
                  <legend>
                    <label className="check">
                      <input type="checkbox" aria-label={`本组全选：${group}`} checked={on === list.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < list.length; }} onChange={(e) => toggleGroup(list, e.target.checked)} />
                      {group}（{on}/{list.length}）
                    </label>
                  </legend>
                  {list.map((i) => (
                    <label key={i.key} className="check" title={i.fixed ? '标识列，固定显示' : i.reason}>
                      <input type="checkbox" checked={set.has(i.key)} disabled={i.fixed} onChange={(e) => toggle(i.key, e.target.checked)} />
                      {i.label}{i.required ? <b className="req"> *</b> : null}{!i.editable && i.col.special !== 'child' ? <small className="muted"> 只读</small> : null}
                    </label>
                  ))}
                </fieldset>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
