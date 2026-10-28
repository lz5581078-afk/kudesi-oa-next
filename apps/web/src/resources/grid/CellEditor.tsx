import { useEffect, useRef, useState } from 'react';
import type { Option } from '@kudesi/shared';
import type { GridCol } from './gridModel';
import { refChoices, searchRefChoices, type RefChoice } from './refResolve';

export type EditResult = { text: string } | { ref: RefChoice | null };
export type Move = 'down' | 'right' | 'left' | 'none';

interface Props {
  col: GridCol;
  /** 打开时输入框里的内容（Enter/双击 = 原值；直接键入 = 键入的字符） */
  initial: string;
  options: readonly Option[];
  onCommit: (r: EditResult, move: Move) => void;
  onCancel: () => void;
}

/** 单元格里的编辑器，按列类型派生：下拉、多选、引用选择、文本类输入。提交 = Enter/Tab/失焦，Esc 取消。 */
export function CellEditor(props: Props) {
  const { col } = props;
  if (col.kind === 'ref') return <RefEditor {...props} />;
  if (col.kind === 'select') return col.field?.multi ? <MultiEditor {...props} /> : <SelectEditor {...props} />;
  return <TextEditor {...props} />;
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
