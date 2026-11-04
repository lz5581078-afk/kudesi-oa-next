import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FieldDef } from '@kudesi/shared';
import { X } from 'lucide-react';
import { resourceApi, type ResourceDto } from './api';
import { useAuth } from '../auth/AuthContext';
import {cachedReferenceOptions,clearReferenceCache,referenceCacheVersion,referenceIdentity,subscribeReferenceCache,type ReferenceOption as RefOption,type ReferenceOptions as RefOptions} from './referenceOptionsCache';
import { loadResourceDirectory } from './resourceDirectory';

/** 普通大目录保留服务端搜索，小目录完整加载。 */
const REF_PAGE=50;
function directoryOrder(rows:ResourceDto[],parentField='parentId',sortField='sort'){
 const ids=new Set(rows.map(row=>row.id)),children=new Map<number,ResourceDto[]>(),seen=new Set<number>(),ordered:ResourceDto[]=[];
 for(const row of rows){const parent=Number(row.data[parentField]);const key=ids.has(parent)?parent:0;children.set(key,[...(children.get(key)??[]),row]);}
 const compare=(a:ResourceDto,b:ResourceDto)=>(Number(a.data[sortField])||0)-(Number(b.data[sortField])||0)||a.id-b.id;
 for(const group of children.values())group.sort(compare);
 const visit=(row:ResourceDto)=>{if(seen.has(row.id))return;seen.add(row.id);ordered.push(row);for(const child of children.get(row.id)??[])visit(child);};
 for(const root of children.get(0)??[])visit(root);for(const row of [...rows].sort(compare))visit(row);
 return ordered;
}
export function useRefVersion(){return useSyncExternalStore(subscribeReferenceCache,referenceCacheVersion);}
function refOptionLabel(target:string,row:ResourceDto){
  if(target==='phones')return [row.title,row.data.certifiedName,row.data.plan,`登记 #${row.id}`].filter(Boolean).join(' · ');
  if(target==='bank-accounts')return [row.title,row.data.bank,row.refLabels?.keeperUserId,`登记 #${row.id}`].filter(Boolean).join(' · ');
  return row.title;
}

/** 按关键字服务端搜索可选项；员工/部门这类小列表不走这里 */
function searchRefOptions(target: string, keyword: string): Promise<RefOptions> {
  return resourceApi.list(target, { pageSize: REF_PAGE, showHidden: true, keyword }).then((r) => Object.assign(r.items.map((i) => ({ value: i.id, label: refOptionLabel(target,i) })), { total: r.total }));
}

/** 选择器上方的搜索框：输入后（稍作防抖）向服务端搜索；用户/部门是整表加载，不显示 */
function useRefSearch(target: string, initial: RefOptions | null) {
  const [keyword, setKeyword] = useState('');
  const [found, setFound] = useState<RefOptions | null>(null);
  const searchable = target !== 'department' && target !== 'user' && (initial?.total ?? 0) > (initial?.length ?? 0);
  useEffect(() => {
    if (!searchable || !keyword.trim()) { setFound(null); return; }
    let alive = true;
    const t = setTimeout(() => { searchRefOptions(target, keyword.trim()).then((o) => alive && setFound(o)).catch(() => alive && setFound([])); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [keyword, searchable, target]);
  return { keyword, setKeyword, searchable, shown: found ?? initial, truncated: (found ?? initial) ? ((found ?? initial)!.total ?? 0) > (found ?? initial)!.length : false };
}
export function clearRefCache(type?:string){clearReferenceCache(type);}
export function loadRefOptions(target:string,scope=''){
 return cachedReferenceOptions(target,scope,async current=>{
  if(target==='department')return (await resourceApi.departments()).map(row=>({value:row.id,label:row.name}));
  if(target==='user')return (await resourceApi.users()).map(row=>({value:row.id,label:row.active?row.name:`${row.name}（已停用）`,disabled:!row.active}));
  if(['finance-categories','finance-supplier-categories','finance-customer-categories','finance-fee-categories','finance-code-dictionaries'].includes(target)){
   const rows=await loadResourceDirectory(target,current,undefined,{includeInactive:true});
   if(!rows)throw new Error('目录读取不完整，请重试');
   const byId=new Map(rows.map(row=>[row.id,row]));
   const path=(row:ResourceDto)=>{const names:string[]=[],seen=new Set<number>();for(let current:ResourceDto|undefined=row;current&&!seen.has(current.id);current=byId.get(Number(current.data.parentId))){seen.add(current.id);names.unshift(current.title);}return names.join(' / ');};
   const visible=directoryOrder(rows).filter(row=>row.status==='active');
   return Object.assign(visible.map(row=>({value:row.id,label:path(row),archiveType:typeof row.data.archiveType==='string'?row.data.archiveType:undefined,importArchiveType:typeof row.data.importArchiveType==='string'?row.data.importArchiveType:undefined,leaf:!rows.some(child=>child.data.parentId===row.id)})),{total:visible.length});
  }
  const response=await resourceApi.list(target,{pageSize:REF_PAGE,showHidden:true});
  return Object.assign(response.items.map(row=>({value:row.id,label:refOptionLabel(target,row)})),{total:response.total});
 });
}

type RefSelectProps = { field: FieldDef; value: unknown; onChange: (v: number | null) => void; labelNow?: string; inputId?: string; leafOnly?: boolean;emptyLabel?:string };

export function RefSelect(props:RefSelectProps){const {user}=useAuth();const scope=referenceIdentity(user);return props.field.refOptions?.complete?<CompleteRefSelect {...props}/>:<PagedRefSelect key={JSON.stringify([scope,props.field.ref])} {...props} scope={scope}/>;}

/** 小字典按原生下拉读取全部候选；不把第51/201项变成另一种搜索交互。 */
function CompleteRefSelect({ field, value, onChange, labelNow, inputId, leafOnly = false,emptyLabel }: RefSelectProps) {
  const { user } = useAuth();
  const version = useRefVersion();
  const scope = JSON.stringify([user?.companyId, user?.id, user?.permissions, field.ref, field.refOptions, leafOnly, version]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const [state, setState] = useState<{ scope: string; rows?: RefOption[]; error?: string }>();
  const [retry, setRetry] = useState(0);
  const select = useRef<HTMLSelectElement>(null), focusAttempted = useRef(false);
  useEffect(() => {
    let alive = true;
    const current = () => alive && scopeRef.current === scope;
    void (async () => {
      const rows = await loadResourceDirectory(field.ref!, current, field.refOptions?.sortField, {includeInactive:leafOnly||field.refOptions?.leafOnly});
      if (!rows) return;
      const visible=rows.filter(row=>Object.entries(field.refOptions?.filters??{}).every(([key,value])=>row.data[key]===value));
      const byId=new Map(visible.map(row=>[row.id,row]));
      const options = (field.refOptions?.pathField?directoryOrder(visible,field.refOptions.pathField,field.refOptions.sortField):visible).map(row => {
        const code=field.refOptions?.codeField&&row.data[field.refOptions.codeField];
        const names:string[]=[],seen=new Set<number>();
        for(let current:ResourceDto|undefined=row;current&&!seen.has(current.id);current=field.refOptions?.pathField?byId.get(Number(current.data[field.refOptions.pathField])):undefined){seen.add(current.id);names.unshift(current.title);}
        const title=names.join(' / ');
        return {value:row.id,label:code?`${title}（${code}）`:title,leaf:!field.refOptions?.pathField||!visible.some(child=>Number(child.data[field.refOptions!.pathField!])===row.id)};
      }).filter(option=>(!leafOnly&&!field.refOptions?.leafOnly||option.leaf)&&byId.get(option.value)?.status==='active');
      if (current()) setState({ scope, rows: options });
    })().catch(() => { if (current()) setState({ scope, error: '可选资料读取失败，当前值仍保留。' }); });
    return () => { alive = false; };
  }, [scope, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = state?.scope === scope ? state : undefined;
  useEffect(() => {
    if (!field.refOptions?.initialFocus || !current?.rows || focusAttempted.current) return;
    focusAttempted.current = true;
    const active = document.activeElement, element = select.current;
    // 等候字典时用户已经开始填写其他字段，则保留用户当前焦点。
    if (element && (active === document.body || active === element || active instanceof HTMLElement && active.matches('button[aria-label="关闭"]') && active.closest('[role="dialog"]') === element.closest('[role="dialog"]'))) element.focus();
  }, [current?.rows, field.refOptions?.initialFocus]);
  const options = current?.rows ?? [];
  const selected = typeof value === 'number' ? value : '';
  return <div className="resource-ref-control">
    <select ref={select} id={inputId} aria-label={field.label} value={selected} disabled={!current?.rows} onChange={event => onChange(event.target.value ? Number(event.target.value) : null)}>
      <option value="">{current?.rows ? emptyLabel ?? `请选择${field.label}` : current?.error ? '读取失败' : '加载中…'}</option>
      {selected !== '' && !options.some(option => option.value === selected) && <option value={selected}>{labelNow || `#${selected}`}</option>}
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {current?.error && <div role="alert">{current.error}<button type="button" className="link-button" onClick={() => { setState(undefined); setRetry(value => value + 1); }}>重试加载</button></div>}
  </div>;
}

function PagedRefSelect({ field, value, onChange, labelNow, inputId, leafOnly = false,scope,emptyLabel='（不选）' }: RefSelectProps&{scope:string}) {
  const version = useRefVersion();
  const [options, setOptions] = useState<RefOptions | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;setOptions(null);setFailed(false);
    loadRefOptions(field.ref!,scope).then((o) => alive && setOptions(o)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [field.ref, version]);
  const search = useRefSearch(field.ref!, options);
  const current = typeof value === 'number' ? value : '';
  if (failed) return <div className="resource-ref-control"><input id={inputId} aria-label={field.label} disabled value={labelNow ?? ''} placeholder="没有权限查看可选项" /><small role="alert">可选资料读取失败，当前值仍保留。</small><button type="button" className="link-button" onClick={() => { setFailed(false); clearRefCache(field.ref); }}>重试加载</button></div>;
  const list: RefOptions = leafOnly ? (search.shown ?? []).filter(o=>o.leaf!==false) : search.shown ?? Object.assign([], { total: 0 });
  const missing = current !== '' && !list.some((o) => o.value === current);
  return (
    <div className="resource-ref-control">
      {search.searchable && <input type="search" className="ref-search" aria-label={`搜索${field.label}`} placeholder="输入关键字搜索…" value={search.keyword} onChange={(e) => search.setKeyword(e.target.value)} />}
      <select id={inputId} aria-label={field.label} value={current} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} disabled={!options}>
        <option value="">{options ? emptyLabel : '加载中…'}</option>
        {missing && <option value={current}>{labelNow ?? `#${current}`}</option>}
        {list.map((o) => (
          // 已停用的员工不能新选；若本来就是这个值则保留显示
          <option key={o.value} value={o.value} disabled={o.disabled && o.value !== current}>
            {o.label}
          </option>
        ))}
      </select>
      {search.truncated && <small className="muted">只列出前 {list.length} 条，共 {list.total ?? '更多'} 条，输入关键字缩小范围</small>}
    </div>
  );
}

/** 多选引用：勾选若干条记录（如供应商同时属于多个分类） */
type RefsSelectProps={field:FieldDef;value:number[];onChange:(v:number[])=>void;labelNow?:string;onLabels?:(labels:Record<number,string>)=>void;leafOnly?:boolean};
export function RefsSelect(props:RefsSelectProps){const {user}=useAuth();const scope=referenceIdentity(user);return <ScopedRefsSelect key={JSON.stringify([scope,props.field.ref])} {...props} scope={scope}/>;}
function ScopedRefsSelect({field,value,onChange,labelNow,onLabels,leafOnly=false,scope}:RefsSelectProps&{scope:string}){
  const version = useRefVersion();
  const [options, setOptions] = useState<RefOptions | null>(null);
  const [failed, setFailed] = useState(false);
  const seen = useRef<Record<number, string>>({});
  useEffect(() => {
    let alive = true;setOptions(null);
    setFailed(false);
    loadRefOptions(field.ref!,scope).then((o) => { if (alive) setOptions(o); }).catch(() => { if (alive) { setFailed(true); setOptions(Object.assign([], { total: 0 })); } });
    return () => { alive = false; };
  }, [field.ref, version]);
  const search = useRefSearch(field.ref!, options);
  if (!options) return <span className="muted" role="status">加载中…</span>;
  const shown: RefOptions = leafOnly ? (search.shown ?? options).filter(o => o.leaf !== false) : search.shown ?? options;
  for (const o of shown) seen.current[o.value] = o.label;
  const labels = (labelNow ?? '').split('、');
  value.forEach((id, i) => { if (!seen.current[id] && labels[i]) seen.current[id] = labels[i]; });
  const labelOf = (id: number) => seen.current[id] || labels[value.indexOf(id)] || `#${id}`;
  const pick = (next: number[]) => { onChange(next); onLabels?.(Object.fromEntries(next.map(id => [id, labelOf(id)]))); };
  const extra = value.filter(id => !shown.some(o => o.value === id));
  return <div className="resource-multi-ref" role="group" aria-label={field.label}>
    <div className="resource-choice-summary"><span>已选 <strong>{value.length}</strong> 项</span><small>可多选</small></div>
    {value.length > 0 && <div className="resource-selected" aria-label={`已选${field.label}`}>{value.map(id => <button key={id} type="button" className="resource-selected-chip" title={labelOf(id)} aria-label={`移除${field.label}：${labelOf(id)}`} onClick={() => pick(value.filter(x => x !== id))}><span>{labelOf(id)}</span><X size={13} aria-hidden="true" /></button>)}</div>}
    {search.searchable && <input type="search" className="ref-search" aria-label={`搜索${field.label}`} placeholder="输入名称或关键词搜索" value={search.keyword} onChange={e => search.setKeyword(e.target.value)} />}
    {failed ? <div className="resource-choice-error" role="alert">可选资料读取失败，已选资料仍保留。<button type="button" className="link-button" onClick={() => clearRefCache(field.ref)}>重试加载</button></div> : <div className="resource-choice-options check-list" aria-label={`${field.label}候选项`}>
      {extra.map(id => <label key={id} className="check"><input type="checkbox" checked onChange={() => pick(value.filter(x => x !== id))} /><span>{labelOf(id)}<small>已选，当前结果之外</small></span></label>)}
      {shown.map(o => <label key={o.value} className="check"><input type="checkbox" checked={value.includes(o.value)} disabled={o.disabled && !value.includes(o.value)} onChange={e => pick(e.target.checked ? [...value, o.value] : value.filter(x => x !== o.value))} /><span>{o.label}</span></label>)}
      {shown.length === 0 && extra.length === 0 && <span className="muted resource-choice-empty">{search.keyword.trim() ? '没有找到匹配资料，请换个关键词' : '还没有可选项'}</span>}
    </div>}
    {search.truncated && <small className="muted resource-choice-more">当前显示 {shown.length} 条，共 {search.shown?.total ?? options.total} 条；搜索可查找更多</small>}
  </div>;
}
