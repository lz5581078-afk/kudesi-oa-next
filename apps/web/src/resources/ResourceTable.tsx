import { useRef, type ReactNode } from 'react';
import { dueBadgeFor, type FieldDef, type ResourceDef } from '@kudesi/shared';
import type { ResourceDto } from './api';
import { CopyButton, isCopyable } from './CopyValue';
import { displayValue, statusOf } from './format';
import { autoColWidth, defaultColWidth, type Density } from './listPrefs';
import type { RowGroup } from './groupRows';

export const SORTABLE = new Set(['text', 'textarea', 'number', 'money', 'date', 'monthday', 'select']);
const CHECK_W = 40;
const STATUS_MIN = 92;
const ACT_W = 196;

type Sort = { by: string; dir: 'asc' | 'desc' } | null;

interface Props {
  def: ResourceDef;
  type: string;
  rows: ResourceDto[] | null;
  columns: FieldDef[];
  widths: Record<string, number>;
  onWidth: (key: string, w: number) => void;
  onWidthCommit: () => void;
  onWidthReset: (key: string) => void;
  density: Density;
  sort: Sort;
  onSort: (key: string) => void;
  checked: number[];
  onCheck: (ids: number[], on: boolean) => void;
  selected: number | null;
  onOpen: (id: number) => void;
  today: string;
  empty: ReactNode;
  loadingText?: string;
  /** 分组显示（配置 listGroupBy）：每组一条可折叠的分组条，组内按原顺序 */
  groups?: RowGroup[];
  folded?: Set<string>;
  onToggleGroup?: (key: string) => void;
  /** 在某个分组里新增（预填分组值）；没有新增权限时不传 */
  onAddInGroup?: (group: RowGroup) => void;
  /** 每行末尾的“办理”列（固定资产领用/归还、档案借出等）；不传就没有这一列 */
  rowActions?: (row: ResourceDto) => ReactNode;
  /** “办理”列的表头叫什么（只读弹窗那类叫“查看”） */
  rowActionsLabel?: string;
  /** 操作列宽（默认 196，分级布局的行内操作多一些） */
  actWidth?: number;
}

/**
 * 列表表格：撑满父容器、表头固定、表体自己滚动；勾选列和第一列冻结，列宽可以拖，行高有紧凑/舒适两档。
 * 只负责展示和点击，数据和筛选都在 ResourcePage。
 */
export function ResourceTable(p: Props) {
  const { def, columns, rows } = p;
  // 没手动调过的列：按第一批数据里最长的内容定宽，之后翻页、筛选也不再变，免得列来回跳
  const auto = useRef<{ type: string; w: Record<string, number> }>({ type: p.type, w: {} });
  if (auto.current.type !== p.type) auto.current = { type: p.type, w: {} };
  if (rows && rows.length) for (const f of columns) if (auto.current.w[f.key] === undefined) auto.current.w[f.key] = autoColWidth(f, rows.map((r) => displayValue(f, r)), isCopyable(def, f) ? 44 : 0);
  const widthOf = (f: FieldDef) => p.widths[f.key] ?? auto.current.w[f.key] ?? defaultColWidth(f);
  const total = CHECK_W + columns.reduce((n, f) => n + widthOf(f), 0) + STATUS_MIN + (p.rowActions ? (p.actWidth ?? ACT_W) : 0);
  const allChecked = !!rows?.length && rows.every((r) => p.checked.includes(r.id));

  const drag = useRef<{ key: string; x: number; w: number } | null>(null);
  const startResize = (e: React.PointerEvent, f: FieldDef) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { key: f.key, x: e.clientX, w: widthOf(f) };
    const move = (ev: PointerEvent) => { if (drag.current) p.onWidth(drag.current.key, drag.current.w + ev.clientX - drag.current.x); };
    const up = () => {
      drag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      p.onWidthCommit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const colSpan = columns.length + 2 + (p.rowActions ? 1 : 0);
  const renderRow = (row: ResourceDto) => {
    const st = statusOf(def, row.status);
    const isSel = row.id === p.selected;
    return (
      <tr
        key={row.id}
        className={isSel ? 'selected' : undefined}
        tabIndex={0}
        aria-selected={isSel}
        onClick={() => p.onOpen(row.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpen(row.id); }
        }}
      >
        <td className="c-check frozen" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" aria-label={`勾选 ${row.title}`} checked={p.checked.includes(row.id)} onChange={(e) => p.onCheck([row.id], e.target.checked)} />
        </td>
        {columns.map((f, i) => {
          const text = displayValue(f, row);
          const due = dueBadgeFor(p.type, f.key, row.data, row.status, p.today);
          return (
            <td key={f.key} data-label={f.label} className={`${i === 0 ? 'frozen first' : ''}${f.type === 'money' ? ' num' : ''}`}>
              <div className="cell">
                <span className="cell-t" title={text || undefined}>{text}</span>
                {isCopyable(def, f) && f.type !== 'number' && text && <CopyButton value={text} label={f.label} />}
                {due && <span className={`pill ${due.level === 'expired' ? 'bad' : 'warn'}`} title="到期提醒按今天的日期实时计算">{due.text}</span>}
              </div>
            </td>
          );
        })}
        <td data-label="状态"><span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span></td>
        {p.rowActions && <td data-label={p.rowActionsLabel ?? '办理'} className="c-acts">{p.rowActions(row)}</td>}
      </tr>
    );
  };
  return (
    <div className="res-table-scroll" data-density={p.density}>
      <table className="res-table" style={{ minWidth: total }}>
        <colgroup>
          <col style={{ width: CHECK_W }} />
          {columns.map((f) => <col key={f.key} style={{ width: widthOf(f) }} />)}
          <col style={{ minWidth: STATUS_MIN }} />
          {p.rowActions && <col style={{ width: p.actWidth ?? ACT_W }} />}
        </colgroup>
        <thead>
          <tr>
            <th className="c-check frozen" scope="col"><input type="checkbox" aria-label="本页全选" checked={allChecked} onChange={(e) => p.onCheck(rows?.map((r) => r.id) ?? [], e.target.checked)} /></th>
            {columns.map((f, i) => {
              const sorted = p.sort?.by === f.key;
              return (
                <th key={f.key} scope="col" className={`${i === 0 ? 'frozen first' : ''}${f.type === 'money' ? ' num' : ''}`} aria-sort={SORTABLE.has(f.type) ? (sorted ? (p.sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}>
                  {SORTABLE.has(f.type) ? (
                    <button type="button" className="th-sort" title="点击排序" onClick={() => p.onSort(f.key)}>
                      {f.label}<span className="th-arrow" aria-hidden="true">{sorted ? (p.sort!.dir === 'asc' ? '↑' : '↓') : ''}</span>
                    </button>
                  ) : <span className="th-text">{f.label}</span>}
                  <span className="col-grip" aria-hidden="true" title="拖动调整列宽，双击恢复" onPointerDown={(e) => startResize(e, f)} onDoubleClick={() => p.onWidthReset(f.key)} />
                </th>
              );
            })}
            <th scope="col">状态</th>
            {p.rowActions && <th scope="col">{p.rowActionsLabel ?? '办理'}</th>}
          </tr>
        </thead>
        <tbody>
          {p.groups
            ? p.groups.flatMap((g) => {
                const open = !p.folded?.has(g.key);
                return [
                  <tr key={`g:${g.key}`} className="res-group-row">
                    <td colSpan={colSpan}>
                      <div className="res-group-bar" style={{ paddingLeft: 12 + g.depth * 16 }}>
                        <button type="button" className="res-group-btn" aria-expanded={open} aria-label={`${g.label}分组`} onClick={() => p.onToggleGroup?.(g.key)}>
                          <span aria-hidden="true">{open ? '▾' : '▸'}</span><strong>{g.label}</strong><em>{g.rows.length} 条</em>{g.note && <em>{g.note}</em>}
                        </button>
                        {p.onAddInGroup && <button type="button" className="link-button grp-add" aria-label={`在${g.label}下新增`} onClick={() => p.onAddInGroup?.(g)}>＋ 新增</button>}
                      </div>
                    </td>
                  </tr>,
                  ...(open ? g.rows.map(renderRow) : []),
                ];
              })
            : rows?.map(renderRow)}
          {rows && rows.length === 0 && <tr className="res-empty-row"><td colSpan={colSpan}>{p.empty}</td></tr>}
          {!rows && <tr className="res-empty-row"><td colSpan={colSpan}><div className="res-loading" role="status"><span className="res-spin" aria-hidden="true" />{p.loadingText ?? '加载中…'}</div></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** 手机上的卡片列表：第一行是名称和状态，下面最多四项关键内容，点整张卡片查看详情。 */
export function ResourceCards(p: Pick<Props, 'def' | 'type' | 'rows' | 'columns' | 'checked' | 'onCheck' | 'selected' | 'onOpen' | 'today' | 'empty' | 'loadingText' | 'groups' | 'folded' | 'onToggleGroup' | 'onAddInGroup'>) {
  const { def, rows } = p;
  if (!rows) return <div className="res-cards-wrap"><div className="res-loading" role="status"><span className="res-spin" aria-hidden="true" />{p.loadingText ?? '加载中…'}</div></div>;
  if (rows.length === 0) return <div className="res-cards-wrap">{p.empty}</div>;
  const metaCols = p.columns.filter((f) => f.key !== def.titleField);
  const renderCard = (row: ResourceDto) => {
    const st = statusOf(def, row.status);
    const metas = metaCols.map((f) => ({ f, text: displayValue(f, row) })).filter((m) => m.text).slice(0, 4);
    return (
      <li key={row.id} className={`res-card${row.id === p.selected ? ' selected' : ''}`} tabIndex={0} aria-selected={row.id === p.selected}
        onClick={() => p.onOpen(row.id)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); p.onOpen(row.id); } }}>
        <div className="res-card-head">
          <input type="checkbox" aria-label={`勾选 ${row.title}`} checked={p.checked.includes(row.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => p.onCheck([row.id], e.target.checked)} />
          <strong className="res-card-title">{row.title}</strong>
          <span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span>
        </div>
        {metas.length > 0 && (
          <dl className="res-card-meta">
            {metas.map(({ f, text }) => {
              const due = dueBadgeFor(p.type, f.key, row.data, row.status, p.today);
              return (
                <div key={f.key} data-label={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{text}{isCopyable(def, f) && f.type !== 'number' && <> <CopyButton value={text} label={f.label} /></>}{due && <> <span className={`pill ${due.level === 'expired' ? 'bad' : 'warn'}`}>{due.text}</span></>}</dd>
                </div>
              );
            })}
          </dl>
        )}
      </li>
    );
  };
  return (
    <ul className="res-cards-wrap res-cards">
      {p.groups
        ? p.groups.flatMap((g) => {
            const open = !p.folded?.has(g.key);
            return [
              <li key={`g:${g.key}`} className="res-group-card">
                <div className="res-group-bar">
                  <button type="button" className="res-group-btn" aria-expanded={open} aria-label={`${g.label}分组`} onClick={() => p.onToggleGroup?.(g.key)}><span aria-hidden="true">{open ? '▾' : '▸'}</span><strong>{g.label}</strong><em>{g.rows.length} 条</em>{g.note && <em>{g.note}</em>}</button>
                  {p.onAddInGroup && <button type="button" className="link-button grp-add" aria-label={`在${g.label}下新增`} onClick={() => p.onAddInGroup?.(g)}>＋ 新增</button>}
                </div>
              </li>,
              ...(open ? g.rows.map(renderCard) : []),
            ];
          })
        : rows.map(renderCard)}
    </ul>
  );
}
