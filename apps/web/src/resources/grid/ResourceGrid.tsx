import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GRID_SAVE_MAX_ROWS, createChecker, gridPolicyOf, permissionOwner, resourcePermission, type FieldDef, type Option, type ResourceDef } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../api/client';
import { resourceApi, type ResourceDto } from '../api';
import { displayValue, statusOf } from '../format';
import { fieldOptions, useUnitOptions } from '../unitOptions';
import { CellEditor, type EditResult, type Move } from './CellEditor';
import { GridBar } from './GridBar';
import { parseTsv, toTsv } from './clipboard';
import {
  applyChanges, applyResponse, buildColumns, buildRequest, cellEditText, chunkRequest, fillChanges, fillDownChanges, historyInit, historyPush, historyRedo, historyUndo,
  isChanged, normSel, replaceRow, rowFromDto, summarize, textToChange, toggleDelete, applicable,
  type CellChange, type GridCol, type GridRow, type History, type Selection,
} from './gridModel';
import { resolveRefLabel } from './refResolve';

const ROW_H = 34;
const OVERSCAN = 8;
const MIN_W = 70;
const widthsKey = (type: string) => `kudesi.grid.widths.${type}`;

function defaultWidth(c: GridCol): number {
  switch (c.kind) {
    case 'bool': return 80;
    case 'money': case 'integer': case 'decimal': return 110;
    case 'date': case 'monthday': return 120;
    case 'phone': return 140;
    default: return c.key === '$status' ? 90 : 160;
  }
}

interface Props {
  def: ResourceDef;
  /** 当前页的记录（服务端按现有筛选/排序/分页给的） */
  items: ResourceDto[];
  /** 要显示的列（沿用列表的“显示列”设置，含统计列） */
  fields: FieldDef[];
  sort: { by: string; dir: 'asc' | 'desc' } | null;
  /** 新增行预先带的值（当前页签/分类） */
  newDefaults?: Record<string, unknown>;
  newLabels?: Record<string, string>;
  onSort: (key: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onOpen: (id: number) => void;
  onSaved: (allOk: boolean) => void;
  onExit: () => void;
}

/**
 * 资料页的表格编辑（飞书表格式）：单元格点击/双击/回车编辑，方向键/Tab 移动，复制粘贴（Excel/飞书多行多列）、
 * Delete 清空、Ctrl+D / 拖拽柄向下填充、Ctrl+Z 撤销。改动先留在本页（高亮），点“保存全部”才一次提交到
 * /resources/:type/grid-save，服务端逐行走与单条保存相同的校验；失败的行留在表格里标红并写明原因。
 * 只在电脑宽屏提供（见 ResourcePage 的 useWideScreen）：手机上没有键盘和宽度，网格编辑没有意义。
 */
export function ResourceGrid(props: Props) {
  const { def, items, fields, sort, newDefaults, newLabels } = props;
  const { user: me } = useAuth();
  const perms = useMemo(() => createChecker(me?.permissions ?? { isCompanyAdmin: false, allow: [], deny: [] }), [me]);
  const owner = permissionOwner(def.key);
  const policy = gridPolicyOf(def.key);
  const canCreate = policy.canCreate && perms(resourcePermission(owner, 'create'));
  const canArchive = policy.canArchive && perms(resourcePermission(owner, 'delete'));
  const canSecret = perms(resourcePermission(owner, 'secret'));
  const units = useUnitOptions();
  const cols = useMemo(() => buildColumns(def, fields, perms, canSecret), [def, fields, perms, canSecret]);
  const defaults = useMemo(() => newDefaults ?? {}, [newDefaults]);

  const [hist, setHist] = useState<History>(() => historyInit(items.map(rowFromDto)));
  const rows = hist.rows;
  const seq = useRef({ n: 0 });
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => { setHist(historyInit(items.map(rowFromDto))); }, [items]);

  const [anchor, setAnchor] = useState({ r: 0, c: 0 });
  const [focus, setFocus] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ r: number; c: number; initial: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [freeze, setFreeze] = useState(true);
  const [widths, setWidths] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem(widthsKey(def.key)) ?? '{}') as Record<string, number>; } catch { return {}; } });
  const [fillTo, setFillTo] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(560);
  const drag = useRef<'select' | 'fill' | null>(null);

  const total = rows.length + (canCreate ? 1 : 0); // 底部多一个空行，直接输入就是新增
  const sel: Selection = normSel(anchor, focus);
  const summary = useMemo(() => summarize(rows, cols, defaults), [rows, cols, defaults]);
  const dirty = summary.total > 0 || summary.errors > 0;
  useEffect(() => { props.onDirtyChange(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const el = scroller.current;
    if (el && el.clientHeight > 0) setViewH(el.clientHeight);
  }, [total]);

  const colWidth = (c: GridCol) => Math.max(MIN_W, widths[c.key] ?? defaultWidth(c));
  const optionsOf = useCallback((field: FieldDef, row: GridRow): readonly Option[] | undefined => (field.type === 'select' ? (field.optionsFrom ? fieldOptions(field, { ...row.data, status: row.status }, units) : field.options) : undefined), [units]);

  // ---------- 改动 ----------
  const edit = useCallback((changes: CellChange[]) => {
    if (!changes.length) return;
    setHist((h) => historyPush(h, applyChanges(h.rows, cols, changes, seq.current, defaults, newLabels)));
  }, [cols, defaults, newLabels]);

  const focusGrid = () => wrap.current?.focus({ preventScroll: true });
  const scrollInto = (r: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = r * ROW_H, h = el.clientHeight || viewH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + h - ROW_H) el.scrollTop = top + ROW_H - h + ROW_H;
  };
  const moveTo = (r: number, c: number, extend = false) => {
    const rr = Math.max(0, Math.min(total - 1, r)), cc = Math.max(0, Math.min(cols.length - 1, c));
    setFocus({ r: rr, c: cc });
    if (!extend) setAnchor({ r: rr, c: cc });
    scrollInto(rr);
  };
  const cur = { r: focus.r, c: focus.c };

  const startEdit = (r: number, c: number, text?: string) => {
    const col = cols[c];
    const row = rows[r];
    if (!col?.editable) return;
    if (row && (row.deleted || !applicable(row, col))) return;
    if (col.kind === 'bool') {
      const now = row?.data[col.key] === true;
      edit([{ row: r, key: col.key, value: !now }]);
      return;
    }
    const initial = text !== undefined ? text : row ? cellEditText(col, row, optionsOf(col.field!, row)) : '';
    setEditing({ r, c, initial });
  };

  const commit = async (r: number, c: number, res: EditResult, move: Move) => {
    setEditing(null);
    const col = cols[c];
    const row = rowsRef.current[r] ?? { ...rowFromDto({ id: 0, type: def.key, title: '', status: '', statusReason: null, data: {}, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' }), key: 'ghost', isNew: true };
    let ch: CellChange;
    if ('ref' in res) ch = { row: r, key: col.key, value: res.ref ? res.ref.id : null, label: res.ref?.label };
    else ch = await textToChange(col, row, r, res.text, { options: optionsOf, resolveRef: resolveRefLabel });
    const same = !('ref' in res) && !ch.invalid && JSON.stringify(ch.value ?? null) === JSON.stringify(row.data[col.key] ?? null) && !row.invalid[col.key];
    if (!same && !(r >= rowsRef.current.length && (ch.value === null || ch.value === undefined) && !ch.invalid)) edit([ch]);
    if (move === 'down') moveTo(r + 1, c);
    else if (move === 'right') moveTo(r, c + 1);
    else if (move === 'left') moveTo(r, c - 1);
    focusGrid();
  };

  const clearSelection = () => {
    const ch: CellChange[] = [];
    for (let r = sel.r1; r <= Math.min(sel.r2, rows.length - 1); r++) for (let c = sel.c1; c <= sel.c2; c++) if (cols[c].editable && cols[c].kind !== 'secret') ch.push({ row: r, key: cols[c].key, value: null });
    edit(ch);
  };

  const copyText = (): string => {
    const out: string[][] = [];
    for (let r = sel.r1; r <= Math.min(sel.r2, rows.length - 1); r++) {
      out.push(cols.slice(sel.c1, sel.c2 + 1).map((col) => (col.field ? cellEditText(col, rows[r], optionsOf(col.field, rows[r])) : statusOf(def, rows[r].status).label)));
    }
    return toTsv(out);
  };

  const paste = async (text: string) => {
    let data = parseTsv(text);
    if (!data.length) return;
    const multi = sel.r1 !== sel.r2 || sel.c1 !== sel.c2;
    const startR = sel.r1, startC = sel.c1;
    const ch: CellChange[] = [];
    const ctx = { options: optionsOf, resolveRef: resolveRefLabel };
    // 单个值粘贴到多选的区域：整块都填这个值（Excel 同款）
    if (data.length === 1 && data[0].length === 1 && multi) {
      const v = data[0][0];
      data = Array.from({ length: Math.min(sel.r2, total - 1) - sel.r1 + 1 }, () => Array.from({ length: sel.c2 - sel.c1 + 1 }, () => v));
    }
    const existing = rows.length;
    if (startR + data.length > existing && startR < existing) {
      const extra = startR + data.length - existing;
      if (canCreate && window.confirm(`粘贴的内容有 ${data.length} 行，超出现有行数 ${extra} 行。要新增这 ${extra} 行吗？\n选“取消”则只粘贴到现有的行。`)) { /* 全部粘贴 */ }
      else data = data.slice(0, existing - startR);
    }
    if (!canCreate) data = data.slice(0, Math.max(0, existing - startR));
    const jobs: Array<Promise<CellChange>> = [];
    data.forEach((line, i) => {
      const r = startR + i;
      const row = rows[r] ?? { ...rowFromDto({ id: 0, type: def.key, title: '', status: '', statusReason: null, data: {}, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' }), key: 'ghost', isNew: true, data: { ...defaults } };
      line.forEach((cell, j) => {
        const c = startC + j;
        const col = cols[c];
        if (!col?.editable || col.kind === 'secret' && cell === '' || (rows[r] && (rows[r].deleted || !applicable(rows[r], col)))) return;
        jobs.push(textToChange(col, row, r, cell, ctx));
      });
    });
    ch.push(...(await Promise.all(jobs)));
    edit(ch);
    const lastR = Math.min(total - 1 + (data.length > 0 ? data.length : 0), startR + data.length - 1);
    setAnchor({ r: startR, c: startC });
    setFocus({ r: Math.max(startR, lastR), c: Math.min(cols.length - 1, startC + Math.max(...data.map((l) => l.length)) - 1) });
  };

  const fillDown = () => edit(fillDownChanges(rows, cols, sel));

  // ---------- 键盘 ----------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const { r, c } = cur;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); setHist(e.shiftKey ? historyRedo : historyUndo); return; }
      if (k === 'y') { e.preventDefault(); setHist(historyRedo); return; }
      if (k === 'd') { e.preventDefault(); fillDown(); return; }
      if (k === 'a') { e.preventDefault(); setAnchor({ r: 0, c: 0 }); setFocus({ r: Math.max(0, rows.length - 1), c: cols.length - 1 }); return; }
      return; // Ctrl+C / V / X 交给 copy / paste / cut 事件
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); return moveTo(r + 1, c, e.shiftKey);
      case 'ArrowUp': e.preventDefault(); return moveTo(r - 1, c, e.shiftKey);
      case 'ArrowLeft': e.preventDefault(); return moveTo(r, c - 1, e.shiftKey);
      case 'ArrowRight': e.preventDefault(); return moveTo(r, c + 1, e.shiftKey);
      case 'Tab': e.preventDefault(); return e.shiftKey ? moveTo(r, c - 1) : moveTo(r, c + 1);
      case 'PageDown': e.preventDefault(); return moveTo(r + 15, c);
      case 'PageUp': e.preventDefault(); return moveTo(r - 15, c);
      case 'Home': e.preventDefault(); return moveTo(r, 0);
      case 'End': e.preventDefault(); return moveTo(r, cols.length - 1);
      case 'Enter': case 'F2': e.preventDefault(); return startEdit(r, c);
      case ' ': if (cols[c]?.kind === 'bool') { e.preventDefault(); startEdit(r, c); } else if (cols[c]?.editable) { e.preventDefault(); startEdit(r, c, ' '); } return;
      case 'Delete': case 'Backspace': e.preventDefault(); return clearSelection();
      case 'Escape': return setAnchor(focus);
      default:
        if ((e.key.length === 1 || e.key === 'Process') && !e.altKey) {
          if (cols[c]?.kind === 'select' || cols[c]?.kind === 'ref') { e.preventDefault(); return startEdit(r, c); }
          if (cols[c]?.kind === 'bool') return;
          // 直接键入：替换原内容（输入法打字时从空开始，字符由输入框接收）
          if (cols[c]?.editable) { if (e.key === 'Process') startEdit(r, c, ''); else { e.preventDefault(); startEdit(r, c, e.key); } }
        }
    }
  };

  // ---------- 鼠标 ----------
  useEffect(() => {
    const up = () => {
      if (drag.current === 'fill' && fillTo !== null) edit(fillChanges(rowsRef.current, cols, normSel(anchor, focus), fillTo));
      if (drag.current === 'fill' && fillTo !== null) setFocus({ r: Math.max(focus.r, fillTo), c: focus.c });
      drag.current = null;
      setFillTo(null);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  });
  const cellOf = (t: EventTarget | null) => {
    const td = (t as HTMLElement | null)?.closest?.('td[data-c]') as HTMLElement | null;
    return td ? { r: Number(td.dataset.r), c: Number(td.dataset.c) } : null;
  };

  // ---------- 保存 ----------
  const save = async () => {
    const live = rowsRef.current;
    const s = summarize(live, cols, defaults);
    if (s.invalid > 0) return setMessage(`有 ${s.invalid} 个格子的内容格式不对（标红），请先修改。`);
    if (s.deleted > 0 && !reason.trim()) return setMessage('有待归档的行，请先填写归档原因。');
    const req = buildRequest(live, cols, reason.trim(), defaults);
    setSaving(true);
    setMessage('');
    let saved = 0, failed = 0;
    try {
      for (const part of chunkRequest(req, GRID_SAVE_MAX_ROWS)) {
        const res = await resourceApi.gridSave(def.key, part);
        saved += res.saved; failed += res.failed;
        setHist((h) => historyInit(applyResponse(h.rows, res)));
      }
      setMessage(failed ? `已保存 ${saved} 行，${failed} 行没有保存成功（标红，原因见最右一列）。` : `已保存 ${saved} 行。`);
      if (!failed) setReason('');
      props.onSaved(failed === 0);
    } catch (e) {
      setMessage(`${e instanceof ApiError ? e.message : '保存失败'}。已保存 ${saved} 行，其余修改还在表格里。`);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    if (dirty && !window.confirm('放弃所有没保存的修改？')) return;
    setHist(historyInit(items.map(rowFromDto)));
    setReason('');
    setMessage('');
  };
  const exit = () => {
    if (dirty && !window.confirm('还有没保存的修改，退出后会丢失。确定退出吗？')) return;
    props.onExit();
  };
  const refreshRow = async (row: GridRow) => {
    if (row.id === undefined) return;
    try { const dto = await resourceApi.get(def.key, row.id); setHist((h) => historyInit(replaceRow(h.rows, row.key, dto))); } catch (e) { setMessage(e instanceof ApiError ? e.message : '刷新失败'); }
  };

  const resizeStart = (e: React.MouseEvent, c: GridCol) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = colWidth(c);
    const move = (ev: MouseEvent) => setWidths((w) => ({ ...w, [c.key]: Math.max(MIN_W, w0 + ev.clientX - x0) }));
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      setWidths((w) => { try { localStorage.setItem(widthsKey(def.key), JSON.stringify(w)); } catch { /* 记不住宽度而已 */ } return w; });
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  // ---------- 渲染 ----------
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const selRows = [...new Set(Array.from({ length: sel.r2 - sel.r1 + 1 }, (_, i) => sel.r1 + i))].filter((r) => r < rows.length);
  const inSel = (r: number, c: number) => r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2;
  const fillSel = fillTo !== null && fillTo > sel.r2;

  const renderCell = (row: GridRow | undefined, r: number, c: number) => {
    const col = cols[c];
    const ghost = !row;
    const active = r === focus.r && c === focus.c;
    const isEditing = editing?.r === r && editing.c === c;
    const bad = row?.invalid[col.key];
    const changed = row ? isChanged(row, col) && !bad && Boolean(col.field) : false;
    const na = row ? !applicable(row, col) : false;
    const cls = ['grid-cell', col.editable && !na ? '' : 'ro', active ? 'active' : '', isEditing ? 'editing' : '', inSel(r, c) ? 'in-sel' : '', changed ? 'changed' : '', bad ? 'invalid' : '', na ? 'na' : '', freeze && c === 0 ? 'frozen' : '', col.kind === 'money' || col.kind === 'integer' || col.kind === 'decimal' ? 'num' : '', fillSel && c >= sel.c1 && c <= sel.c2 && r > sel.r2 && r <= fillTo! ? 'fill-preview' : ''].filter(Boolean).join(' ');
    let text = '';
    if (row) {
      if (!col.field) text = row.isNew ? '新增' : statusOf(def, row.status).label;
      else if (bad) text = bad.raw;
      else if (col.kind === 'secret') text = row.data[col.key] ? '••••••' : row.secretConfigured[col.key] ? '已设置' : '';
      else if (na) text = '';
      else text = displayValue(col.field, { data: row.data, refLabels: row.refLabels, secretConfigured: row.secretConfigured } as ResourceDto);
    }
    const tip = bad ? bad.error : changed && row && !row.isNew ? `原值：${displayValue(col.field!, { data: row.base, refLabels: {}, secretConfigured: row.secretConfigured } as ResourceDto) || '（空）'}` : !col.editable ? col.reason : undefined;
    return (
      <td key={col.key} role="gridcell" data-r={r} data-c={c} aria-selected={inSel(r, c)} aria-readonly={!col.editable || na} aria-invalid={Boolean(bad)} className={cls} title={tip}
        style={freeze && c === 0 ? { left: 64 } : undefined}>
        {isEditing ? (
          <CellEditor col={col} initial={editing!.initial} options={(row ? optionsOf(col.field!, row) : col.field?.options) ?? []}
            onCommit={(res, move) => void commit(r, c, res, move)} onCancel={() => { setEditing(null); focusGrid(); }} />
        ) : col.kind === 'bool' && row && !na ? (
          <span className="grid-bool" aria-label={`${col.label}：${row.data[col.key] === true ? '是' : '否'}`}>{row.data[col.key] === true ? '是' : row.data[col.key] === false ? '否' : ''}</span>
        ) : <span className="grid-text">{text}{ghost && c === 0 && !isEditing ? <span className="muted">＋ 在这里输入，新增一行</span> : null}</span>}
        {active && !isEditing && r === sel.r2 && c === sel.c2 && r < rows.length && cols.some((x) => x.editable) && (
          <span className="fill-handle" role="presentation" title="向下拖动填充（Ctrl+D 填满选区）" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); drag.current = 'fill'; setFillTo(r); }} />
        )}
      </td>
    );
  };

  return (
    <div className="grid-wrap">
      <GridBar
        total={summary.total} invalid={summary.invalid} deleted={summary.deleted} errors={summary.errors} saving={saving}
        canUndo={hist.past.length > 0} canRedo={hist.future.length > 0} canArchive={canArchive} freeze={freeze} reason={reason} selectedRows={selRows.length}
        message={message}
        onUndo={() => setHist(historyUndo)} onRedo={() => setHist(historyRedo)}
        onDeleteRows={() => setHist((h) => historyPush(h, toggleDelete(h.rows, selRows)))}
        onFreeze={setFreeze} onReason={setReason} onSave={() => void save()} onDiscard={discard} onExit={exit} onDismiss={() => setMessage('')}
      />
      <div
        ref={wrap} className="grid-scope" tabIndex={0} role="application" aria-label={`${def.label}表格编辑，方向键移动，回车编辑，Ctrl+V 粘贴`}
        onKeyDown={onKeyDown}
        onCopy={(e) => { if (editing) return; e.preventDefault(); e.clipboardData.setData('text/plain', copyText()); }}
        onCut={(e) => { if (editing) return; e.preventDefault(); e.clipboardData.setData('text/plain', copyText()); clearSelection(); }}
        onPaste={(e) => { if (editing) return; e.preventDefault(); void paste(e.clipboardData.getData('text/plain')); }}
      >
        <div ref={scroller} className="grid-scroller" onScroll={(e) => { setScrollTop(e.currentTarget.scrollTop); setViewH(e.currentTarget.clientHeight || viewH); }}>
          <table className="grid-table" role="grid" aria-rowcount={total} aria-colcount={cols.length + 2} style={{ width: 64 + cols.reduce((s, c) => s + colWidth(c), 0) + 220 }}>
            <colgroup><col style={{ width: 64 }} />{cols.map((c) => <col key={c.key} style={{ width: colWidth(c) }} />)}<col style={{ width: 220 }} /></colgroup>
            <thead>
              <tr>
                <th className="grid-corner" scope="col">#</th>
                {cols.map((c, ci) => {
                  const sortable = c.field && ['text', 'textarea', 'number', 'money', 'date', 'monthday', 'select'].includes(c.field.type);
                  const dir = sort?.by === c.key ? sort.dir : null;
                  return (
                    <th key={c.key} scope="col" className={`${freeze && ci === 0 ? 'frozen' : ''}${c.editable ? '' : ' ro'}`} style={freeze && ci === 0 ? { left: 64 } : undefined} aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} title={c.editable ? undefined : c.reason}>
                      {sortable && !dirty ? <button type="button" className="link-button" title="点击排序" onClick={() => props.onSort(c.key)}>{c.label}{dir ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button> : <span>{c.label}</span>}
                      <span className="col-resizer" role="separator" aria-label={`调整${c.label}列宽`} onMouseDown={(e) => resizeStart(e, c)} />
                    </th>
                  );
                })}
                <th scope="col" className="grid-result-head">保存结果</th>
              </tr>
            </thead>
            <tbody onMouseDown={(e) => {
              const p = cellOf(e.target);
              if (!p || (editing && p.r === editing.r && p.c === editing.c)) return; // 点别的格子：失焦即提交当前编辑，再选中它
              if (e.shiftKey) setFocus(p); else { setAnchor(p); setFocus(p); }
              drag.current = 'select';
              focusGrid();
              if (document.activeElement !== wrap.current) e.preventDefault();
            }} onMouseOver={(e) => {
              const p = cellOf(e.target);
              if (!p) return;
              if (drag.current === 'select') setFocus(p);
              else if (drag.current === 'fill') setFillTo(Math.max(p.r, sel.r2));
            }} onDoubleClick={(e) => { const p = cellOf(e.target); if (p) startEdit(p.r, p.c); }}>
              {start > 0 && <tr aria-hidden="true" style={{ height: start * ROW_H }}><td colSpan={cols.length + 2} /></tr>}
              {Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i).map((r) => {
                const row = rows[r];
                return (
                  <tr key={row?.key ?? 'ghost'} aria-rowindex={r + 2} className={['grid-row', row?.isNew ? 'new' : '', row?.deleted ? 'deleted' : '', row?.error ? 'failed' : '', !row ? 'ghost' : ''].filter(Boolean).join(' ')} style={{ height: ROW_H }}>
                    <th scope="row" className="grid-rowhead" onMouseDown={(e) => { e.preventDefault(); setAnchor({ r, c: 0 }); setFocus({ r, c: cols.length - 1 }); focusGrid(); }}>
                      <span>{r + 1}</span>
                      {row && !row.isNew && row.id !== undefined && <button type="button" className="icon-button" aria-label={`打开 ${row.title} 的详情`} title="在右侧打开详情" onClick={() => props.onOpen(row.id!)}>↗</button>}
                    </th>
                    {cols.map((_, c) => renderCell(row, r, c))}
                    <td className="grid-result" role="gridcell">
                      {row?.error ? (
                        <span className="grid-error" role="alert" title={row.error.message}>
                          {row.error.message}
                          {row.error.code === 'conflict' && <> <button type="button" className="link-button" onClick={() => void refreshRow(row)}>放弃我的修改，载入最新</button></>}
                        </span>
                      ) : row?.deleted ? <span className="muted">待归档</span> : row?.isNew ? <span className="muted">待新增</span> : row && cols.some((c) => c.field && isChanged(row, c)) ? <span className="muted">待保存</span> : null}
                    </td>
                  </tr>
                );
              })}
              {end < total && <tr aria-hidden="true" style={{ height: (total - end) * ROW_H }}><td colSpan={cols.length + 2} /></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted grid-help">单击选中、双击或回车编辑；Tab / 方向键移动；Ctrl+C / V 复制粘贴（可从 Excel、飞书整块粘贴）；Delete 清空；Ctrl+D 或拖右下角小方块向下填充；Ctrl+Z 撤销。灰色列不能在这里改。</p>
    </div>
  );
}
