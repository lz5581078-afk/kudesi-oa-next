import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FieldDef } from '@kudesi/shared';
import { X } from 'lucide-react';
import { resourceApi, type ResourceDto } from './api';
import { useAuth } from '../auth/AuthContext';
import { loadResourceDirectory } from './resourceDirectory';

type RefOption = { value: number; label: string; disabled?: boolean; leaf?: boolean; archiveType?: string };
type RefOptions = RefOption[] & { total?: number };
/** 引用选择器一次最多取这么多条；更多的靠搜索框按关键字找（店铺、手机号等可能有几百条） */
const REF_PAGE = 50;
let refVersion = 0;
const refListeners = new Set<() => void>();
function useRefVersion() { return useSyncExternalStore(cb => { refListeners.add(cb); return () => { refListeners.delete(cb); }; }, () => refVersion); }
const refCache = new Map<string, Promise<RefOptions>>();
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
export function clearRefCache(type?: string) {
  if (type) refCache.delete(type);
  else refCache.clear();
  refVersion++; refListeners.forEach(listener => listener());
}

export function loadRefOptions(target: string) {
  let p = refCache.get(target);
  if (!p) {
    p =
      target === 'department'
        ? resourceApi.departments().then((list) => list.map((d) => ({ value: d.id, label: d.name })))
        : target === 'user'
        ? resourceApi.users().then((list) => list.map((u) => ({ value: u.id, label: u.active ? u.name : `${u.name}（已停用）`, disabled: !u.active })))
        : ['finance-categories','finance-supplier-categories','finance-customer-categories','finance-fee-categories'].includes(target)
        ? (async () => { const rows: ResourceDto[] = []; for (let page=1;;page++) { const r=await resourceApi.list(target,{page,pageSize:200,showHidden:true}); rows.push(...r.items); if(rows.length>=r.total||!r.items.length)break; } const byId=new Map(rows.map(r=>[r.id,r])); const path=(row:ResourceDto)=>{const parts:string[]=[],seen=new Set<number>();for(let r:ResourceDto|undefined=row;r&&!seen.has(r.id);r=byId.get(Number(r.data.parentId))){seen.add(r.id);parts.unshift(r.title);}return parts.join(' / ');};return Object.assign(rows.filter(r=>r.status==='active').map(r=>({value:r.id,label:path(r),archiveType:typeof r.data.archiveType === 'string' ? r.data.archiveType : undefined,leaf:!rows.some(c=>c.data.parentId===r.id)})),{total:rows.filter(r=>r.status==='active').length}); })()
        : resourceApi.list(target, { pageSize: REF_PAGE, showHidden: true }).then((r) => Object.assign(r.items.map((i) => ({ value: i.id, label: refOptionLabel(target,i) })), { total: r.total }));
    p.catch(() => refCache.delete(target));
    refCache.set(target, p);
  }
  return p;
}

type RefSelectProps = { field: FieldDef; value: unknown; onChange: (v: number | null) => void; labelNow?: string; inputId?: string; leafOnly?: boolean };

export function RefSelect(props: RefSelectProps) {
  return props.field.refOptions?.complete ? <CompleteRefSelect {...props}/> : <PagedRefSelect {...props}/>;
}

/** 小字典按原生下拉读取全部候选；不把第51/201项变成另一种搜索交互。 */
function CompleteRefSelect({ field, value, onChange, labelNow, inputId }: RefSelectProps) {
  const { user } = useAuth();
  const version = useRefVersion();
  const scope = JSON.stringify([user?.companyId, user?.id, user?.permissions, field.ref, field.refOptions, version]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const [state, setState] = useState<{ scope: string; rows?: RefOption[]; error?: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    const current = () => alive && scopeRef.current === scope;
    void (async () => {
      const rows = await loadResourceDirectory(field.ref!, current, field.refOptions?.sortField);
      if (!rows) return;
      const options = rows.map(row => {
        const code = field.refOptions?.codeField && row.data[field.refOptions.codeField];
        return { value: row.id, label: code ? `${row.title}（${code}）` : row.title };
      });
      if (current()) setState({ scope, rows: options });
    })().catch(() => { if (current()) setState({ scope, error: '可选资料读取失败，当前值仍保留。' }); });
    return () => { alive = false; };
  }, [scope, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = state?.scope === scope ? state : undefined;
  const options = current?.rows ?? [];
  const selected = typeof value === 'number' ? value : '';
  return <div className="resource-ref-control">
    <select id={inputId} aria-label={field.label} value={selected} disabled={!current?.rows} onChange={event => onChange(event.target.value ? Number(event.target.value) : null)}>
      <option value="">{current?.rows ? `请选择${field.label}` : current?.error ? '读取失败' : '加载中…'}</option>
      {selected !== '' && !options.some(option => option.value === selected) && <option value={selected}>{labelNow || `#${selected}`}</option>}
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {current?.error && <div role="alert">{current.error}<button type="button" className="link-button" onClick={() => { setState(undefined); setRetry(value => value + 1); }}>重试加载</button></div>}
  </div>;
}

function PagedRefSelect({ field, value, onChange, labelNow, inputId, leafOnly = false }: RefSelectProps) {
  const version = useRefVersion();
  const [options, setOptions] = useState<RefOptions | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadRefOptions(field.ref!).then((o) => alive && setOptions(o)).catch(() => alive && setFailed(true));
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
        <option value="">{options ? '（不选）' : '加载中…'}</option>
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
export function RefsSelect({ field, value, onChange, labelNow, onLabels, leafOnly = false }: { field: FieldDef; value: number[]; onChange: (v: number[]) => void; labelNow?: string; onLabels?: (labels: Record<number, string>) => void; leafOnly?: boolean }) {
  const version = useRefVersion();
  const [options, setOptions] = useState<RefOptions | null>(null);
  const [failed, setFailed] = useState(false);
  const seen = useRef<Record<number, string>>({});
  useEffect(() => {
    let alive = true;
    setFailed(false);
    loadRefOptions(field.ref!).then((o) => { if (alive) setOptions(o); }).catch(() => { if (alive) { setFailed(true); setOptions(Object.assign([], { total: 0 })); } });
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
