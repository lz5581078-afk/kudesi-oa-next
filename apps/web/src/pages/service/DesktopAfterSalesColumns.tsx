import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Filter, GripVertical, X } from 'lucide-react';
import {
  AFTER_SALES_COLUMNS, AFTER_SALES_SORT_COLUMNS, JST_AFTER_SALES_COLUMNS,
  AFTER_SALES_MAX_COLUMN_WIDTH, afterSalesMinColumnWidth, clampAfterSalesColumnWidth,
  type AfterSalesColumn, type AfterSalesColumnFilter, type AfterSalesWidthColumn,
} from '@kudesi/shared';

const SOURCE_COLUMNS = new Set<AfterSalesColumn>(JST_AFTER_SALES_COLUMNS);
const ALL_COLUMNS = [
  ...JST_AFTER_SALES_COLUMNS, ...AFTER_SALES_COLUMNS.filter(column=>!SOURCE_COLUMNS.has(column)),
];
export const DEFAULT_COLUMNS: AfterSalesColumn[] = [...JST_AFTER_SALES_COLUMNS];
export type AfterSalesSort = { key: typeof AFTER_SALES_SORT_COLUMNS[number]; direction: 'asc' | 'desc' };

const DEFAULT_WIDTHS: Partial<Record<AfterSalesWidthColumn, number>> = {
  序号:44, 操作:148, 售后单号:148, 内部订单号:112, 商品信息:206,
  线上订单号:174, 线上售后单号:174, 原始线上单号:174, 外部交易单号:174,
  线上类型:88, 线上状态:118, 售后单状态:104, 货物状态:98,
  退货快递单号:168, 发货快递单号:168, 快递单号:150, 平台售后详情:164,
  店铺:154, 收货地址:184, 平台卖家退货地址:184, OA处理进度:154,
  备注:146, 买家留言:146, 卖家备注:146, 供分销备注:146,
  '原订单备注/旗帜':146, 原订单线下备注:146, 拒绝原因:146, 退款原因:146,
  拦截失败原因:146, 售后问题登记:146, 商品明细:166, 售后商品明细:166,
  售后日志:146, 订单操作日志:146, 发货物流明细:166, 退货物流明细:166,
  原订单下单金额:118, 实退金额:92, 申请退货数量:100, 实退数量:88, 紧急度:78,
};

export function defaultAfterSalesColumnWidth(column: AfterSalesWidthColumn) {
  if(/时间$|日期$|下次跟进/.test(column))return 100;
  return DEFAULT_WIDTHS[column] ?? Math.min(132, Math.max(82, 44 + column.length * 11));
}

type ColumnDrag = {
  pointer:number; x:number; start:number; next:number; track:ElementCSSInlineStyle; table:HTMLTableElement;
};

function clearColumnPreview(active:ColumnDrag) {
  active.track.style.removeProperty('--ds-preview-width');
  active.table.style.removeProperty('--ds-resize-delta');
  delete active.table.dataset.resizing;
}

function ColumnResize({column,width,onChange}: {
  column:AfterSalesWidthColumn; width:number; onChange:(column:AfterSalesWidthColumn,width?:number)=>void;
}) {
  const drag=useRef<ColumnDrag|null>(null);
  const left=column==='操作';
  useEffect(()=>()=>{if(drag.current)clearColumnPreview(drag.current);},[]);
  function start(event:PointerEvent<HTMLSpanElement>) {
    if(event.button!==0||drag.current)return;
    const header=event.currentTarget.closest('th');
    const table=header?.closest('table');
    const track=header&&table?.querySelector('colgroup')?.children[header.cellIndex];
    if(!(track instanceof HTMLTableColElement)||!table)return;
    event.preventDefault();
    event.currentTarget.focus({preventScroll:true});
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current={pointer:event.pointerId,x:event.clientX,start:width,next:width,track,table};
    table.dataset.resizing='true';
  }
  function move(event:PointerEvent<HTMLSpanElement>) {
    const active=drag.current;
    if(!active||active.pointer!==event.pointerId)return;
    active.next=clampAfterSalesColumnWidth(column,active.start+(event.clientX-active.x)*(left?-1:1));
    active.track.style.setProperty('--ds-preview-width',active.next+'px');
    active.table.style.setProperty('--ds-resize-delta',(active.next-active.start)+'px');
    event.currentTarget.setAttribute('aria-valuenow',String(active.next));
  }
  function finish(handle:HTMLSpanElement,commit:boolean) {
    const active=drag.current;
    if(!active)return;
    drag.current=null;
    clearColumnPreview(active);
    handle.setAttribute('aria-valuenow',String(commit?active.next:width));
    if(handle.hasPointerCapture?.(active.pointer))handle.releasePointerCapture(active.pointer);
    if(commit&&active.next!==active.start)onChange(column,active.next);
  }
  return <span className={'ds-column-resize'+(left?' ds-column-resize-left':'')} role="separator" tabIndex={0}
    aria-label={`调整${column}列宽`} aria-orientation="vertical"
    aria-valuemin={afterSalesMinColumnWidth(column)} aria-valuemax={AFTER_SALES_MAX_COLUMN_WIDTH} aria-valuenow={width}
    title="拖动调宽，双击恢复默认"
    onPointerDown={start} onPointerMove={move}
    onPointerUp={event=>{if(drag.current?.pointer===event.pointerId)finish(event.currentTarget,true);}}
    onPointerCancel={event=>finish(event.currentTarget,false)}
    onLostPointerCapture={event=>finish(event.currentTarget,false)}
    onDoubleClick={()=>onChange(column)}
    onKeyDown={event=>{
      if(event.key==='Escape'&&drag.current){event.preventDefault();finish(event.currentTarget,false);}
      if(drag.current)return;
      if(event.key==='Home'){event.preventDefault();onChange(column);}
      if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
        event.preventDefault();
        const next=clampAfterSalesColumnWidth(column,width+(event.key==='ArrowLeft'?-8:8));
        if(next!==width)onChange(column,next);
      }
    }}/>;
}

export function moveColumn(columns: AfterSalesColumn[], from: AfterSalesColumn, to: AfterSalesColumn) {
  const i = columns.indexOf(from), j = columns.indexOf(to);
  if (i < 0 || j < 0 || i === j) return columns;
  const next = [...columns];
  next.splice(i, 1);
  next.splice(j, 0, from);
  return next;
}

export function ColumnPicker({columns, onChange, onResetWidths}: {
  columns: AfterSalesColumn[]; onChange: (columns: AfterSalesColumn[]) => void; onResetWidths:()=>void;
}) {
  const [search, setSearch] = useState('');
  const [over,setOver]=useState<AfterSalesColumn|null>(null);
  const dragged=useRef<AfterSalesColumn|null>(null);
  const finish=()=>{dragged.current=null;setOver(null);};
  return <section className="ds-column-picker" aria-label="显示列">
    <div className="ds-actions">
      <input aria-label="查找列" placeholder="查找列名" value={search} onChange={e=>setSearch(e.target.value)}/>
      <button type="button" onClick={()=>onChange([...ALL_COLUMNS])}>显示全部</button>
      <button type="button" onClick={()=>onChange([...JST_AFTER_SALES_COLUMNS])}>按聚水潭显示</button>
      <button type="button" onClick={()=>onChange(DEFAULT_COLUMNS)}>恢复默认列</button>
      <button type="button" onClick={onResetWidths}>恢复默认列宽</button>
    </div>
    <div className="ds-column-layout">
      <div><strong>已显示 {columns.length} 列</strong><small>拖住手柄调整顺序</small>
        <ol className="ds-column-order" aria-label="已显示列的顺序">
          {columns.map((column,index)=><li key={column} className={over===column?'ds-column-drop':undefined}
            onDragOver={event=>{if(dragged.current&&dragged.current!==column){event.preventDefault();setOver(column);}}}
            onDrop={event=>{if(!dragged.current)return;event.preventDefault();onChange(moveColumn(columns,dragged.current,column));finish();}}>
            <span draggable className="ds-column-grip" title={`拖动${column}`} onDragStart={event=>{
              dragged.current=column;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',column);
            }} onDragEnd={finish}><GripVertical size={15}/></span><span>{column}</span>
            <button type="button" aria-label={`上移${column}`} disabled={index===0} onClick={()=>onChange(moveColumn(columns,column,columns[index-1]))}><ArrowUp size={13}/></button>
            <button type="button" aria-label={`下移${column}`} disabled={index===columns.length-1} onClick={()=>onChange(moveColumn(columns,column,columns[index+1]))}><ArrowDown size={13}/></button>
            <button type="button" aria-label={`隐藏${column}`} disabled={column==='售后单号'} onClick={()=>onChange(columns.filter(value=>value!==column))}><X size={13}/></button>
          </li>)}
        </ol>
      </div>
      <div><strong>可添加的列</strong><div className="ds-column-choices">
        {ALL_COLUMNS.filter(column=>!columns.includes(column)&&column.includes(search.trim())).map(column=><button type="button" key={column}
          aria-label={`显示${column}`} onClick={()=>onChange([...columns,column])}>＋ {column}</button>)}
      </div></div>
    </div>
  </section>;
}

export function AfterSalesTableHead({columns, filters, sort, columnWidth, onResize, onMove, onFilter, onSort}: {
  columns: AfterSalesColumn[]; filters: AfterSalesColumnFilter[]; sort: AfterSalesSort;
  columnWidth:(column:AfterSalesWidthColumn)=>number;
  onResize:(column:AfterSalesWidthColumn,width?:number)=>void;
  onMove: (from: AfterSalesColumn, to: AfterSalesColumn) => void;
  onFilter: (column: AfterSalesColumn) => void;
  onSort: (sort: AfterSalesSort) => void;
}) {
  const dragged = useRef<AfterSalesColumn | null>(null);
  const [over, setOver] = useState<AfterSalesColumn | null>(null);
  function endDrag() { dragged.current = null; setOver(null); }
  const resize=(column:AfterSalesWidthColumn)=><ColumnResize column={column} width={columnWidth(column)} onChange={onResize}/>;
  return <thead><tr><th scope="col">序号{resize('序号')}</th>
    {columns.map((column,index)=>{
      const sortable = AFTER_SALES_SORT_COLUMNS.find(key=>key===column);
      const filtered = filters.some(f=>f.column===column);
      return <th key={column} scope="col" data-column={column} className={over===column?'ds-column-drop':undefined}
        aria-sort={sort.key===column?(sort.direction==='asc'?'ascending':'descending'):undefined}
        onDragOver={e=>{if(dragged.current&&dragged.current!==column){e.preventDefault();setOver(column);}}}
        onDrop={e=>{e.preventDefault();if(dragged.current)onMove(dragged.current,column);endDrag();}}>
        <div className="ds-column-head">
          <span draggable className="ds-column-grip" title={`拖动${column}`}
            onDragStart={e=>{dragged.current=column;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',column);}}
            onDragEnd={endDrag}><GripVertical size={13}/></span>
          {sortable?<button type="button" className="ds-column-name" title={column}
            onClick={()=>onSort({key:sortable,direction:sort.key===column&&sort.direction==='desc'?'asc':'desc'})}>
            {column}{sort.key===column?(sort.direction==='desc'?' ↓':' ↑'):''}
          </button>:<span className="ds-column-name" title={column}>{column}</span>}
          <button type="button" className={filtered?'ds-column-filter is-active':'ds-column-filter'}
            aria-label={`筛选${column}`} title={`筛选${column}`} onClick={()=>onFilter(column)}><Filter size={13}/></button>
          <button type="button" className="ds-key-move" aria-label={`${column}向左移动`} disabled={index===0}
            onClick={()=>onMove(column,columns[index-1])}><ArrowLeft size={13}/></button>
          <button type="button" className="ds-key-move" aria-label={`${column}向右移动`} disabled={index===columns.length-1}
            onClick={()=>onMove(column,columns[index+1])}><ArrowRight size={13}/></button>
        </div>
        {resize(column)}
      </th>;
    })}
    <th scope="col">操作{resize('操作')}</th>
  </tr></thead>;
}
