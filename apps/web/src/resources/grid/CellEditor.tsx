import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Option, ResourceDef } from '@kudesi/shared';
import type { FileInfo } from '../api';
import { FilesInput } from '../FilesField';
import { AttrsInput, ReasonDialog, RefsSelect } from '../RecordForm';
import type { GridCol, GridRow } from './gridModel';
import { refChoices, searchRefChoices, type RefChoice } from './refResolve';

/**
 * 提交结果：text = 文本类（由 parseGridCell 转换）；ref = 单引用；value = 弹出浮层选好的现成值（多引用、文件、属性、清单、多行文本）；
 * status = 状态列选的状态（需要原因的带原因）。
 */
export type EditResult = { text: string } | { ref: RefChoice | null } | { value: unknown; label?: string; files?: Record<number, FileInfo> } | { status: string | null; reason?: string };
export type Move = 'down' | 'right' | 'left' | 'none';

interface Props {
  col: GridCol;
  /** 打开时输入框里的内容（Enter/双击 = 原值；直接键入 = 键入的字符） */
  initial: string;
  options: readonly Option[];
  def: ResourceDef;
  /** 正在编辑的行（弹出浮层要看这一行的其他值、已上传的文件）；新增的底部空行没有 */
  row?: GridRow;
  onCommit: (r: EditResult, move: Move) => void;
  onCancel: () => void;
}

/** 单元格里的编辑器，按列类型派生：下拉、多选、引用选择、文本类输入。提交 = Enter/Tab/失焦，Esc 取消。 */
export function CellEditor(props: Props) {
  const { col } = props;
  if (col.special === 'status') return <StatusEditor {...props} />;
  switch (col.kind) {
    case 'ref': return <RefEditor {...props} />;
    case 'refs': return <RefsEditor {...props} />;
    case 'select': return col.field?.multi ? <MultiEditor {...props} /> : <SelectEditor {...props} />;
    case 'date': return <DateEditor {...props} />;
    case 'textarea': return <TextAreaEditor {...props} />;
    case 'files': return <FilesDialog {...props} />;
    case 'attrs': return <AttrsDialog {...props} />;
    case 'json': return <JsonDialog {...props} />;
    default: return <TextEditor {...props} />;
  }
}

function keyMove(e: React.KeyboardEvent): Move | 'cancel' | null {
  if (e.key === 'Escape') return 'cancel';
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) return 'down';
  if (e.key === 'Tab') return e.shiftKey ? 'left' : 'right';
  return null;
}

function TextEditor({ col, initial, onCommit, onCancel }: Props) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (move: Move) => { if (done.current) return; done.current = true; onCommit({ text }, move); };
  const hint = col.kind === 'date' ? 'YYYY-MM-DD' : col.kind === 'money' ? '元' : col.kind === 'monthday' ? 'MM-DD' : undefined;
  return (
    <input
      className="grid-input"
      autoFocus
      aria-label={`编辑${col.label}`}
      type={col.kind === 'secret' ? 'password' : 'text'}
      autoComplete="off"
      placeholder={hint}
      inputMode={col.kind === 'integer' || col.kind === 'decimal' || col.kind === 'money' ? 'decimal' : undefined}
      value={text}
      onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish('none')}
      onKeyDown={(e) => {
        const m = keyMove(e);
        if (!m) return;
        e.preventDefault();
        e.stopPropagation();
        if (m === 'cancel') { done.current = true; onCancel(); } else finish(m);
      }}
    />
  );
}

function SelectEditor({ col, initial, options, onCommit, onCancel }: Props) {
  const done = useRef(false);
  const cur = options.find((o) => o.label === initial || o.value === initial)?.value ?? '';
  return (
    <select
      className="grid-input"
      autoFocus
      aria-label={`选择${col.label}`}
      defaultValue={cur}
      onChange={(e) => { done.current = true; onCommit({ text: e.target.value }, 'none'); }}
      onBlur={() => { if (!done.current) { done.current = true; onCancel(); } }}
      onKeyDown={(e) => {
        const m = keyMove(e);
        if (m === 'cancel') { e.stopPropagation(); done.current = true; onCancel(); }
        else if (m === 'down' || m === 'right' || m === 'left') { e.preventDefault(); e.stopPropagation(); done.current = true; onCommit({ text: e.currentTarget.value }, m); }
      }}
    >
      <option value="">（空）</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {cur === '' && initial && !options.some((o) => o.label === initial) && <option value={initial}>{initial}</option>}
    </select>
  );
}

function MultiEditor({ col, initial, options, onCommit, onCancel }: Props) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial.split('、').map((l) => options.find((o) => o.label === l || o.value === l)?.value).filter((x): x is string => Boolean(x))));
  const done = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const finish = (move: Move) => { if (done.current) return; done.current = true; onCommit({ text: options.filter((o) => picked.has(o.value)).map((o) => o.value).join('、') }, move); };
  return (
    <div
      ref={box}
      className="grid-pop"
      role="group"
      aria-label={`多选${col.label}`}
      tabIndex={-1}
      onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) finish('none'); }}
      onKeyDown={(e) => {
        const m = keyMove(e);
        if (!m) return;
        e.preventDefault(); e.stopPropagation();
        if (m === 'cancel') { done.current = true; onCancel(); } else finish(m);
      }}
    >
      {options.map((o, i) => (
        <label key={o.value} className="check">
          <input autoFocus={i === 0} type="checkbox" checked={picked.has(o.value)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(o.value); else n.delete(o.value); return n; })} />
          {o.label}
        </label>
      ))}
      <button type="button" className="link-button" onClick={() => finish('none')}>确定</button>
    </div>
  );
}

function RefEditor({ col, initial, onCommit, onCancel }: Props) {
  const target = col.field!.ref!;
  const [keyword, setKeyword] = useState('');
  const [list, setList] = useState<RefChoice[] | null>(null);
  const [hi, setHi] = useState(0);
  const done = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      (keyword.trim() ? searchRefChoices(target, keyword.trim()) : refChoices(target)).then((l) => { if (alive) { setList(l); setHi(0); } }).catch(() => alive && setList([]));
    }, keyword ? 200 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [keyword, target]);
  const pick = (c: RefChoice | null, move: Move) => { if (done.current) return; done.current = true; onCommit({ ref: c }, move); };
  const shown = list ?? [];
  return (
    <div ref={box} className="grid-pop" onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) { if (!done.current) { done.current = true; onCancel(); } } }}>
      <input
        className="grid-input"
        autoFocus
        aria-label={`搜索${col.label}`}
        placeholder={initial ? `当前：${initial}，输入关键字搜索` : '输入关键字搜索'}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setHi((h) => Math.min(shown.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done.current = true; onCancel(); }
          else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault(); e.stopPropagation();
            const c = shown[hi];
            if (c && !c.disabled) pick(c, 'down');
            else if (!keyword.trim() && !shown.length) pick(null, 'down');
          } else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); const c = shown[hi]; if (c && !c.disabled) pick(c, e.shiftKey ? 'left' : 'right'); }
        }}
      />
      <ul role="listbox" aria-label={`${col.label}可选项`}>
        <li><button type="button" className="link-button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(null, 'none')}>（清空）</button></li>
        {list === null && <li className="muted">加载中…</li>}
        {list && shown.length === 0 && <li className="muted">没有匹配的记录</li>}
        {shown.map((c, i) => (
          <li key={c.id} role="option" aria-selected={i === hi}>
            <button type="button" className={i === hi ? 'active' : undefined} disabled={c.disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c, 'none')}>{c.label}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- 日期：可手输，也可点右边的日历选 ----------

function DateEditor({ col, initial, onCommit, onCancel }: Props) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const box = useRef<HTMLSpanElement>(null);
  const finish = (move: Move, value = text) => { if (done.current) return; done.current = true; onCommit({ text: value }, move); };
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
  return (
    <span ref={box} className="grid-date" onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) finish('none'); }}>
      <input
        className="grid-input"
        autoFocus
        aria-label={`编辑${col.label}`}
        autoComplete="off"
        placeholder="YYYY-MM-DD"
        value={text}
        onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const m = keyMove(e);
          if (!m) return;
          e.preventDefault(); e.stopPropagation();
          if (m === 'cancel') { done.current = true; onCancel(); } else finish(m);
        }}
      />
      <input type="date" className="grid-datepick" aria-label={`用日历选择${col.label}`} value={iso} onChange={(e) => { setText(e.target.value); if (e.target.value) finish('none', e.target.value); }} />
    </span>
  );
}

// ---------- 弹出框的共用部分 ----------

/** 点到浮层外面 = 提交（和别的编辑器失焦提交一致） */
function useOutside(ref: React.RefObject<HTMLElement | null>, fn: () => void) {
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) f.current(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref]);
}

function Pop({ label, wide, children, onOk, onCancel, hint }: { label: string; wide?: boolean; children: ReactNode; onOk: () => void; onCancel: () => void; hint?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useOutside(box, onOk);
  return (
    <div
      ref={box}
      className={wide ? 'grid-pop wide' : 'grid-pop'}
      role="group"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); onOk(); }
      }}
    >
      {children}
      <div className="grid-pop-foot">
        {hint && <small className="muted">{hint}</small>}
        <button type="button" className="secondary-button small" onClick={onCancel}>取消</button>
        <button type="button" className="primary-button small" onClick={onOk}>确定</button>
      </div>
    </div>
  );
}

/** 居中的完整编辑浮层（文件、属性、清单这类单元格里放不下的）；放到 body 上，不被表格滚动区裁掉 */
export function GridDialog({ title, children, onOk, onCancel, error, okLabel = '确定', hideOk }: { title: string; children: ReactNode; onOk?: () => void; onCancel: () => void; error?: string; okLabel?: string; hideOk?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onCancel(); } };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onCancel]);
  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label={title}>
        <div className="modal-head between"><strong>{title}</strong><button type="button" className="icon-button" aria-label="关闭浮层" onClick={onCancel}>✕</button></div>
        <div className="modal-body">{children}{error && <div role="alert" className="notice error">{error}</div>}</div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onCancel}>{hideOk ? '关闭' : '取消'}</button>
          {!hideOk && <button type="button" className="primary-button" onClick={onOk}>{okLabel}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- 多行文本 ----------

function TextAreaEditor({ col, initial, onCommit, onCancel }: Props) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const max = col.field?.maxLength ?? 200;
  const finish = () => { if (done.current) return; done.current = true; onCommit({ text }, 'none'); };
  const cancel = () => { if (done.current) return; done.current = true; onCancel(); };
  return (
    <Pop label={`编辑${col.label}`} wide onOk={finish} onCancel={cancel} hint={`${text.length}/${max}　Enter 换行，Ctrl+Enter 确定`}>
      <textarea
        className="grid-textarea"
        autoFocus
        rows={5}
        aria-label={`编辑${col.label}`}
        value={text}
        onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); finish(); } }}
      />
    </Pop>
  );
}

// ---------- 多引用 ----------

function RefsEditor({ col, row, onCommit, onCancel }: Props) {
  const field = col.field!;
  const cur = Array.isArray(row?.data[col.key]) ? (row!.data[col.key] as number[]) : [];
  const names = (row?.refLabels[col.key] ?? '').split('、');
  const known = useRef<Record<number, string>>(Object.fromEntries(cur.map((id, i) => [id, names[i] ?? `#${id}`])));
  const [ids, setIds] = useState<number[]>(cur);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onCommit({ value: ids.length ? ids : null, label: ids.map((id) => known.current[id] ?? `#${id}`).join('、') }, 'none');
  };
  const cancel = () => { if (done.current) return; done.current = true; onCancel(); };
  return (
    <Pop label={`多选${col.label}`} wide onOk={finish} onCancel={cancel} hint="最多 10 项">
      <RefsSelect field={field} value={ids} onChange={setIds} labelNow={row?.refLabels[col.key]} onLabels={(m) => { known.current = { ...known.current, ...m }; }} />
    </Pop>
  );
}

// ---------- 文件 ----------

function FilesDialog({ col, row, def, onCommit, onCancel }: Props) {
  const field = col.field!;
  const cur = Array.isArray(row?.data[col.key]) ? (row!.data[col.key] as number[]) : [];
  const [ids, setIds] = useState<number[]>(cur);
  const [known, setKnown] = useState<Record<number, FileInfo>>(row?.files ?? {});
  return (
    <GridDialog title={`${field.label}（${def.label}${row && !row.isNew ? `「${row.title}」` : ''}）`} onCancel={onCancel} onOk={() => onCommit({ value: ids.length ? ids : null, files: known }, 'none')}>
      <FilesInput field={field} type={def.key} value={ids} known={known} onChange={setIds} onKnown={(f) => setKnown((k) => ({ ...k, [f.id]: f }))} />
    </GridDialog>
  );
}

// ---------- 属性（分类自定义属性） ----------

function AttrsDialog({ col, row, def, onCommit, onCancel }: Props) {
  const field = col.field!;
  const [val, setVal] = useState<unknown>(row?.data[col.key] ?? {});
  return (
    <GridDialog title={`${field.label}（${def.label}${row && !row.isNew ? `「${row.title}」` : ''}）`} onCancel={onCancel} onOk={() => {
      const o = Object.fromEntries(Object.entries((val && typeof val === 'object' ? val : {}) as Record<string, unknown>).filter(([, v]) => String(v ?? '').trim() !== ''));
      onCommit({ value: Object.keys(o).length ? o : null }, 'none');
    }}>
      <AttrsInput field={field} def={def} values={row?.data ?? {}} value={val} onChange={setVal} />
    </GridDialog>
  );
}

// ---------- 结构化清单（JSON） ----------

function JsonDialog({ col, row, def, onCommit, onCancel }: Props) {
  const field = col.field!;
  const v = row?.data[col.key];
  const [text, setText] = useState(v === undefined || v === null ? '' : JSON.stringify(v, null, 2));
  const [error, setError] = useState('');
  return (
    <GridDialog title={`${field.label}（${def.label}${row && !row.isNew ? `「${row.title}」` : ''}）`} error={error} onCancel={onCancel} onOk={() => {
      if (text.trim() === '') return onCommit({ value: null }, 'none');
      try {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed !== 'object' || parsed === null) throw new Error('bad');
        onCommit({ value: parsed }, 'none');
      } catch {
        setError('不是合法的 JSON，应为 {…} 或 […]');
      }
    }}>
      {field.help && <p className="muted">{field.help}</p>}
      <textarea className="grid-textarea mono" rows={14} aria-label={`编辑${field.label}（JSON）`} autoFocus value={text} onChange={(e) => { setText(e.target.value); setError(''); }} />
    </GridDialog>
  );
}

// ---------- 状态：和详情页的状态下拉同一规则，需要原因的先弹原因框 ----------

function StatusEditor({ col, row, onCommit, onCancel }: Props) {
  const statuses = col.statuses ?? [];
  const cur = row?.statusTo ?? row?.status ?? '';
  const [pending, setPending] = useState<string | null>(null);
  const done = useRef(false);
  const target = statuses.find((x) => x.value === pending);
  return (
    <>
      <select
        className="grid-input"
        autoFocus
        aria-label="更改状态"
        defaultValue={cur}
        onChange={(e) => {
          const next = e.target.value;
          const st = statuses.find((x) => x.value === next);
          if (st?.requiresReason) return setPending(next);
          done.current = true;
          onCommit({ status: next }, 'none');
        }}
        onBlur={() => { if (!done.current && !pending) { done.current = true; onCancel(); } }}
        onKeyDown={(e) => {
          const m = keyMove(e);
          if (m === 'cancel') { e.stopPropagation(); done.current = true; onCancel(); }
          else if (m === 'down' || m === 'right' || m === 'left') { e.preventDefault(); e.stopPropagation(); done.current = true; onCancel(); }
        }}
      >
        {statuses.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
      </select>
      {target && createPortal(
        <ReasonDialog
          title={`改为“${target.label}”`}
          hint="原因会记录在操作记录里。点“保存全部”时才真正生效。"
          confirmLabel="确认"
          onClose={() => { done.current = true; onCancel(); }}
          onConfirm={async (reason) => { done.current = true; onCommit({ status: target.value, reason }, 'none'); }}
        />,
        document.body,
      )}
    </>
  );
}
