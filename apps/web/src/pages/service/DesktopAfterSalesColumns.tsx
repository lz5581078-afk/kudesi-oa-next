import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Filter, GripVertical } from 'lucide-react';
import {
  AFTER_SALES_COLUMNS, AFTER_SALES_SORT_COLUMNS,
  type AfterSalesColumn, type AfterSalesColumnFilter,
} from '@kudesi/shared';

const STORAGE_KEY = 'oa.afterSales.columns';
export const DEFAULT_COLUMNS: AfterSalesColumn[] = [
  '售后单号', '申请时间', '店铺', '线上类型', '线上状态', '售后单状态',
  '货物状态', '内部订单号', 'OA处理进度', '负责人', '下次跟进',
];
export type AfterSalesSort = { key: typeof AFTER_SALES_SORT_COLUMNS[number]; direction: 'asc' | 'desc' };

export function readColumns(): AfterSalesColumn[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (Array.isArray(saved)) {
      const columns = [...new Set(saved.filter((v): v is AfterSalesColumn => AFTER_SALES_COLUMNS.includes(v)))];
      if (columns.length) return columns.includes('售后单号') ? columns : ['售后单号', ...columns];
    }
  } catch { /* Optional browser preferences. */ }
  return DEFAULT_COLUMNS;
}

export function writeColumns(columns: AfterSalesColumn[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(columns)); }
  catch { /* The current layout still works without storage. */ }
}

export function moveColumn(columns: AfterSalesColumn[], from: AfterSalesColumn, to: AfterSalesColumn) {
  const i = columns.indexOf(from), j = columns.indexOf(to);
  if (i < 0 || j < 0 || i === j) return columns;
  const next = [...columns];
  next.splice(i, 1);
  next.splice(j, 0, from);
  return next;
}

export function ColumnPicker({columns, onChange}: {
  columns: AfterSalesColumn[]; onChange: (columns: AfterSalesColumn[]) => void;
}) {
  const [search, setSearch] = useState('');
  return <section className="ds-column-picker" aria-label="显示列">
    <div className="ds-actions">
      <input aria-label="查找列" placeholder="查找列名" value={search} onChange={e=>setSearch(e.target.value)}/>
      <button type="button" onClick={()=>onChange([...AFTER_SALES_COLUMNS])}>显示全部</button>
      <button type="button" onClick={()=>onChange(DEFAULT_COLUMNS)}>恢复默认列</button>
    </div>
    <div className="ds-column-choices">
      {AFTER_SALES_COLUMNS.filter(k=>k.includes(search.trim())).map(k=><label key={k}>
        <input type="checkbox" checked={columns.includes(k)} disabled={k==='售后单号'}
          onChange={e=>onChange(e.target.checked?[...columns,k]:columns.filter(v=>v!==k))}/>{k}
      </label>)}
    </div>
  </section>;
}

export function AfterSalesTableHead({columns, filters, sort, onMove, onFilter, onSort}: {
  columns: AfterSalesColumn[]; filters: AfterSalesColumnFilter[]; sort: AfterSalesSort;
  onMove: (from: AfterSalesColumn, to: AfterSalesColumn) => void;
  onFilter: (column: AfterSalesColumn) => void;
  onSort: (sort: AfterSalesSort) => void;
}) {
  const dragged = useRef<AfterSalesColumn | null>(null);
  const [over, setOver] = useState<AfterSalesColumn | null>(null);
  function endDrag() { dragged.current = null; setOver(null); }
  return <thead><tr><th scope="col">序号</th>
    {columns.map((column,index)=>{
      const sortable = AFTER_SALES_SORT_COLUMNS.find(key=>key===column);
      const filtered = filters.some(f=>f.column===column);
      return <th key={column} scope="col" className={over===column?'ds-column-drop':undefined}
        aria-sort={sort.key===column?(sort.direction==='asc'?'ascending':'descending'):undefined}
        onDragOver={e=>{if(dragged.current&&dragged.current!==column){e.preventDefault();setOver(column);}}}
        onDrop={e=>{e.preventDefault();if(dragged.current)onMove(dragged.current,column);endDrag();}}>
        <div className="ds-column-head">
          <span draggable className="ds-column-grip" title={`拖动${column}`}
            onDragStart={e=>{dragged.current=column;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',column);}}
            onDragEnd={endDrag}><GripVertical size={13}/></span>
          {sortable?<button type="button" className="ds-column-name"
            onClick={()=>onSort({key:sortable,direction:sort.key===column&&sort.direction==='desc'?'asc':'desc'})}>
            {column}{sort.key===column?(sort.direction==='desc'?' ↓':' ↑'):''}
          </button>:<span className="ds-column-name">{column}</span>}
          <button type="button" className={filtered?'ds-column-filter is-active':'ds-column-filter'}
            aria-label={`筛选${column}`} title={`筛选${column}`} onClick={()=>onFilter(column)}><Filter size={13}/></button>
          <button type="button" className="ds-key-move" aria-label={`${column}向左移动`} disabled={index===0}
            onClick={()=>onMove(column,columns[index-1])}><ArrowLeft size={13}/></button>
          <button type="button" className="ds-key-move" aria-label={`${column}向右移动`} disabled={index===columns.length-1}
            onClick={()=>onMove(column,columns[index+1])}><ArrowRight size={13}/></button>
        </div>
      </th>;
    })}
    <th scope="col">操作</th>
  </tr></thead>;
}
