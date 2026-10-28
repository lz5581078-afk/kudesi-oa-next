import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  COL_FILTER_OPS, COL_FILTER_OP_LABEL, COL_FILTER_VALUES_MAX, DATE_PRESETS, datePresetRange, unitYuanText, yuanToPreciseCents, validateColFilters,
  type ColFilter, type ColFilterKind, type ColFilterOp, type FieldDef,
} from '@kudesi/shared';
import { FilterIcon } from '../ResIcons';

export interface MenuOption { value: string; label: string }

export interface ColumnMenuProps {
  label: string;
  field: FieldDef | null;
  kind: ColFilterKind;
  current: ColFilter[];
  /** 已选值的名称（引用的名称、选项名称），标签和勾选列表用 */
  labels: Record<string, string>;
  sortable: boolean;
  sortDir: 'asc' | 'desc' | null;
  /** 有没保存的修改：筛选和排序都锁住 */
  locked: boolean;
  today: string;
  /** 单选 / 状态列的全部选项 */
  options?: MenuOption[];
  /** 单选 / 状态列各值的数量（按其它列的条件） */
  loadFacets?: () => Promise<Array<{ value: string; count: number }>>;
  /** 引用列：按名称搜候选 */
  searchRef?: (keyword: string) => Promise<MenuOption[]>;
  onSort: (dir: 'asc' | 'desc' | null) => void;
  /** next=null 清除这一列的筛选；labels 是新选值的名称 */
  onApply: (next: ColFilter | null, labels: Record<string, string>) => void;
}

/** 金额：输入的是元，筛选条件按存储的单位（分，最多 4 位小数）传给服务端 */
const toStored = (field: FieldDef | null, text: string): string | null => {
  const s = text.replace(/[¥￥,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  if (field?.type !== 'money') return s;
  try { return String(yuanToPreciseCents(s, field.scale ?? 0)); } catch { return null; }
};

/** 展示用：金额存的是分，输入框里显示元 */
const fromStored = (field: FieldDef | null, v: string | undefined): string => {
  if (!v) return '';
  return field?.type === 'money' ? unitYuanText(Number(v)) : v;
};

/** 列头菜单：排序 + 按字段类型给的筛选方式。浮层挂在 body 上，不会被表格的滚动区域裁掉。 */
export function ColumnMenu(p: ColumnMenuProps) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const count = p.current.length === 1 && p.current[0].op === 'in' ? (p.current[0].values?.length ?? 1) : p.current.length;
  const on = p.current.length > 0;

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 300)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btn.current?.focus(); } };
    const away = () => setOpen(false);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', away);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); window.removeEventListener('resize', away); };
  }, [open]);
  useEffect(() => { if (p.locked) setOpen(false); }, [p.locked]);

  return (
    <>
      <button
        ref={btn} type="button" className={`colf-btn${on ? ' on' : ''}`} disabled={p.locked}
        aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${p.label}列筛选${on ? `，已有 ${count} 个条件` : ''}`}
        title={p.locked ? '有没保存的修改：请先保存或放弃，再筛选或排序' : `筛选 / 排序：${p.label}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <FilterIcon size={12} />
        {on && <b className="colf-count">{count}</b>}
      </button>
      {open && createPortal(
        <div ref={pop} className="colf-pop" role="dialog" aria-label={`${p.label}的筛选和排序`} style={{ top: pos.top, left: pos.left }}>
          {p.sortable && (
            <div className="colf-sort" role="group" aria-label="排序">
              <button type="button" className={p.sortDir === 'asc' ? 'on' : ''} aria-pressed={p.sortDir === 'asc'} onClick={() => { p.onSort(p.sortDir === 'asc' ? null : 'asc'); setOpen(false); }}>升序 ↑</button>
              <button type="button" className={p.sortDir === 'desc' ? 'on' : ''} aria-pressed={p.sortDir === 'desc'} onClick={() => { p.onSort(p.sortDir === 'desc' ? null : 'desc'); setOpen(false); }}>降序 ↓</button>
            </div>
          )}
          <FilterEditor key={p.label} {...p} onDone={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </>
  );
}

function FilterEditor(p: ColumnMenuProps & { onDone: () => void }) {
  const cur = p.current[0];
  const ops = COL_FILTER_OPS[p.kind];
  const firstOp = (): ColFilterOp => (cur && (ops as readonly string[]).includes(cur.op) ? cur.op : ops[0]);
  const [op, setOp] = useState<ColFilterOp>(firstOp);
  const [v1, setV1] = useState(() => (p.kind === 'number' ? fromStored(p.field, cur?.value) : cur?.value ?? ''));
  const [v2, setV2] = useState(() => (p.kind === 'number' ? fromStored(p.field, cur?.value2) : cur?.value2 ?? ''));
  const [picked, setPicked] = useState<string[]>(cur?.values ?? []);
  const [pickedLabels, setPickedLabels] = useState<Record<string, string>>(p.labels);
  const [error, setError] = useState('');
  const [facets, setFacets] = useState<Record<string, number>>({});
  const [kw, setKw] = useState('');
  const [found, setFound] = useState<MenuOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');

  useEffect(() => {
    if (!p.loadFacets) return;
    let alive = true;
    p.loadFacets().then((rows) => { if (alive) setFacets(Object.fromEntries(rows.map((r) => [r.value, r.count]))); }).catch(() => undefined);
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (p.kind !== 'ref' || !p.searchRef || op !== 'in') return;
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      p.searchRef!(kw.trim()).then((r) => { if (alive) { setFound(r); setSearchErr(''); } }).catch(() => { if (alive) { setFound([]); setSearchErr('没有权限查看候选，或加载失败'); } }).finally(() => { if (alive) setSearching(false); });
    }, kw ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [kw, op, p.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const needValue = !['empty', 'notEmpty', 'yes', 'no', 'in'].includes(op);
  const toggle = (value: string, label: string) => {
    setPicked((cur2) => (cur2.includes(value) ? cur2.filter((x) => x !== value) : [...cur2, value].slice(0, COL_FILTER_VALUES_MAX)));
    setPickedLabels((l) => ({ ...l, [value]: label }));
  };

  function build(): ColFilter | null {
    const key = p.field?.key ?? '$status';
    const f: ColFilter = { key, op };
    if (op === 'in') f.values = picked;
    else if (needValue) {
      if (p.kind === 'number') {
        const a = toStored(p.field, v1);
        if (a === null) { setError('请填写数字'); return null; }
        f.value = a;
        if (op === 'between') { const b = toStored(p.field, v2); if (b === null) { setError('请填写区间的两端'); return null; } f.value2 = b; }
      } else {
        f.value = v1;
        if (op === 'between') f.value2 = v2;
      }
    }
    const check = validateColFilters([f], { fields: p.field ? [p.field] : [], statuses: p.kind === 'status' ? (p.options ?? []).map((o) => o.value) : undefined });
    if (!check.ok) { setError(check.error); return null; }
    return check.filters[0];
  }
  const apply = () => {
    const f = build();
    if (!f) return;
    const labels: Record<string, string> = {};
    for (const v of f.values ?? []) if (pickedLabels[v]) labels[v] = pickedLabels[v];
    p.onApply(f, labels);
    p.onDone();
  };
  const clear = () => { p.onApply(null, {}); p.onDone(); };
  const setPreset = (preset: (typeof DATE_PRESETS)[number]['value']) => {
    const r = datePresetRange(preset, p.today);
    setOp('between'); setV1(r.from); setV2(r.to); setError('');
  };

  const opSelect = ops.length > 2 || p.kind === 'ref' || p.kind === 'select' ? (
    <label className="colf-row"><span>方式</span>
      <select aria-label="筛选方式" value={op} onChange={(e) => { setOp(e.target.value as ColFilterOp); setError(''); }}>
        {ops.map((o) => <option key={o} value={o}>{o === 'in' ? (p.kind === 'ref' ? '选择' : '勾选') : COL_FILTER_OP_LABEL[o]}</option>)}
      </select>
    </label>
  ) : null;

  const inputType = p.kind === 'date' ? 'date' : 'text';

  return (
    <div className="colf-body">
      {p.kind === 'presence' && <p className="colf-note">加密存放的内容（证件号、银行卡、密码等）不能按内容筛选，只能看已填 / 未填，避免从筛选结果里猜出明文。</p>}
      {p.kind === 'presence' && (
        <div className="colf-radios" role="radiogroup" aria-label="已填或未填">
          {ops.map((o) => (
            <label key={o} className="check"><input type="radio" name="presence" checked={op === o} onChange={() => setOp(o)} />{o === 'notEmpty' ? '已填' : '未填'}</label>
          ))}
        </div>
      )}
      {p.kind === 'bool' && (
        <div className="colf-radios" role="radiogroup" aria-label="是或否">
          <label className="check"><input type="radio" name="bool" checked={false} onChange={clear} />全部</label>
          {ops.map((o) => <label key={o} className="check"><input type="radio" name="bool" checked={op === o && p.current.length > 0} onChange={() => { setOp(o); p.onApply({ key: p.field!.key, op: o }, {}); p.onDone(); }} />{COL_FILTER_OP_LABEL[o]}</label>)}
        </div>
      )}
      {p.kind === 'date' && (
        <div className="colf-presets" role="group" aria-label="日期快捷">
          {DATE_PRESETS.map((d) => <button key={d.value} type="button" onClick={() => setPreset(d.value)}>{d.label}</button>)}
        </div>
      )}
      {p.kind !== 'presence' && p.kind !== 'bool' && p.kind !== 'status' && opSelect}
      {needValue && (
        <div className="colf-values">
          <input aria-label={op === 'between' ? '起点' : '值'} type={inputType} inputMode={p.kind === 'number' ? 'decimal' : undefined} value={v1} maxLength={100} placeholder={p.kind === 'phone' ? '手机号的一部分' : p.kind === 'number' && p.field?.type === 'money' ? '金额（元）' : undefined}
            onChange={(e) => { setV1(e.target.value); setError(''); }} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} />
          {op === 'between' && <><span className="colf-to">至</span><input aria-label="终点" type={inputType} inputMode={p.kind === 'number' ? 'decimal' : undefined} value={v2} maxLength={100} onChange={(e) => { setV2(e.target.value); setError(''); }} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} /></>}
        </div>
      )}
      {op === 'in' && (p.kind === 'select' || p.kind === 'status') && (
        <ul className="colf-list" aria-label="选择值">
          {(p.options ?? []).map((o) => (
            <li key={o.value}>
              <label className="check"><input type="checkbox" checked={picked.includes(o.value)} onChange={() => toggle(o.value, o.label)} />
                <span className="colf-opt">{o.label}</span>{facets[o.value] !== undefined && <i className="colf-n">{facets[o.value]}</i>}
              </label>
            </li>
          ))}
          {(p.options ?? []).length === 0 && <li className="colf-note">没有可选的值</li>}
        </ul>
      )}
      {op === 'in' && p.kind === 'ref' && (
        <>
          <input type="search" aria-label="按名称搜索" placeholder="输入名称搜索" value={kw} onChange={(e) => setKw(e.target.value)} />
          {picked.length > 0 && (
            <div className="colf-picked" aria-label="已选">
              {picked.map((v) => <span key={v} className="res-chip">{pickedLabels[v] ?? `#${v}`}<button type="button" aria-label={`取消${pickedLabels[v] ?? v}`} onClick={() => setPicked((x) => x.filter((y) => y !== v))}>✕</button></span>)}
            </div>
          )}
          <ul className="colf-list" aria-label="候选">
            {found.filter((o) => !picked.includes(o.value)).map((o) => (
              <li key={o.value}><label className="check"><input type="checkbox" checked={false} onChange={() => toggle(o.value, o.label)} /><span className="colf-opt">{o.label}</span></label></li>
            ))}
            {searching && <li className="colf-note">搜索中…</li>}
            {!searching && searchErr && <li className="colf-note">{searchErr}</li>}
            {!searching && !searchErr && found.length === 0 && <li className="colf-note">没有匹配的</li>}
          </ul>
        </>
      )}
      {error && <div role="alert" className="colf-err">{error}</div>}
      {p.kind !== 'bool' && (
        <div className="colf-foot">
          <button type="button" className="link-button" disabled={!p.current.length} onClick={clear}>清除这一列</button>
          <button type="button" className="res-btn primary sm" onClick={apply}>应用</button>
        </div>
      )}
    </div>
  );
}
