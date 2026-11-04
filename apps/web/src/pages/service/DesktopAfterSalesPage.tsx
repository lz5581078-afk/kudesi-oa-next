import {useEffect,useRef,useState,useCallback} from 'react';
import {AFTER_SALES_FIELDS,type DesktopSaleArchive,type DesktopSaleSnapshot,type DesktopSaleListRow,type DesktopCollectionSource} from '@kudesi/shared';
import {Settings2,ArrowUp,ArrowDown,X,Search,ExternalLink} from 'lucide-react';
import './desktopBridge';
import {DesktopCollectionStatus} from './DesktopCollectionStatus';
import {RunDetail} from '../flow/RunDetail';
import {api} from '../../api/client';
import './desktopAfterSales.css';
type Options={stores:Array<{id:number;name:string}>;people:Array<{id:number;name:string}>};
type List={total:number;rows:DesktopSaleListRow[]};
const BASE_COLUMNS=['售后单号','内部订单号',...AFTER_SALES_FIELDS,'OA处理进度','负责人','紧急度','下次跟进'];
const DEFAULT_COLUMNS=['售后单号','内部订单号',...AFTER_SALES_FIELDS.slice(0,24),'OA处理进度','负责人','紧急度'];
function readColumns(){try{const saved=JSON.parse(localStorage.getItem('oa.afterSales.columns')??'null');if(Array.isArray(saved)){const values=saved.filter((v):v is string=>typeof v==='string'&&BASE_COLUMNS.includes(v));if(values.length)return [...new Set(['售后单号',...values])];}}catch{/* use source table defaults */}return DEFAULT_COLUMNS;}
const PRIORITIES=['普通','关注','紧急','特急'];
function cellValue(row:DesktopSaleListRow,key:string){if(key==='售后单号')return row.afterSaleId;if(key==='内部订单号')return row.internalOrderId;if(key==='OA处理进度')return row.progress;if(key==='负责人')return row.ownerName;if(key==='紧急度')return PRIORITIES[row.priority??0];if(key==='下次跟进')return row.nextAt?new Date(row.nextAt).toLocaleString():'';return row.snapshot?.fields[key as keyof DesktopSaleSnapshot['fields']]??'';}

const localDate=(value:string|null)=>{if(!value)return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
export function DesktopAfterSalesPage(){
 const bridge=window.oaDesktop,viewport=useRef<HTMLDivElement>(null),selectedRef=useRef<DesktopSaleArchive|null>(null),request=useRef(0);
 const [options,setOptions]=useState<Options>({stores:[],people:[]}),[list,setList]=useState<List>({total:0,rows:[]});
 const [selected,setSelected]=useState<DesktopSaleArchive|null>(null),[snapshots,setSnapshots]=useState<DesktopSaleSnapshot[]>([]),[snapshotIndex,setSnapshotIndex]=useState(0);
 const [storeId,setStoreId]=useState(''),[company,setCompany]=useState(''),[keyword,setKeyword]=useState(''),[page,setPage]=useState(1);
 const [progress,setProgress]=useState(''),[owner,setOwner]=useState(''),[nextAt,setNextAt]=useState(''),[note,setNote]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[tab,setTab]=useState<'follow'|'source'>('follow'),[shortcut,setShortcut]=useState('CommandOrControl+Shift+S');
 const [portal,setPortal]=useState(false),[settings,setSettings]=useState(false),[columns,setColumns]=useState<string[]>(readColumns),[columnSettings,setColumnSettings]=useState(false);
 const [sort,setSort]=useState({key:'申请时间',direction:'desc'}),[sources,setSources]=useState<DesktopCollectionSource[]>([]),[sourceId,setSourceId]=useState('');
 const [localEnabled,setLocalEnabled]=useState(false),[localKind,setLocalKind]=useState<'current'|'history'>('current'),[searchField,setSearchField]=useState<'afterSaleId'|'internalOrderId'>('afterSaleId');
 const [localPage,setLocalPage]=useState(1),[localHasNext,setLocalHasNext]=useState(false),[localResult,setLocalResult]=useState(false);
 const [priority,setPriority]=useState(0),[rowColor,setRowColor]=useState(''),[report,setReport]=useState(''),[recipient,setRecipient]=useState(''),[message,setMessage]=useState('');
 const [flowId,setFlowId]=useState<number|null>(null),[caseType,setCaseType]=useState('other'),[flowAmount,setFlowAmount]=useState('0'),[flowReason,setFlowReason]=useState('');
 const source=sources.find(s=>String(s.id)===sourceId);
 const sortedRows=list.rows;
 const sortable=['\u7533\u8bf7\u65f6\u95f4','\u552e\u540e\u5355\u53f7','\u5185\u90e8\u8ba2\u5355\u53f7','\u7d27\u6025\u5ea6','\u8d1f\u8d23\u4eba','\u4e0b\u6b21\u8ddf\u8fdb'];
 const setColumnPreferences=(values:string[])=>{setColumns(values);try{localStorage.setItem('oa.afterSales.columns',JSON.stringify(values));}catch{/* local preferences optional */}};
 const refreshCollection=useCallback(()=>{void api<DesktopCollectionSource[]>('/desktop-after-sales-collection').then(v=>{if(Array.isArray(v))setSources(v);}).catch(()=>undefined);},[]);
 const metadataDirty=useRef(false);const dirty=useRef(false),draftVersion=useRef(0);const snapshot=snapshots[snapshotIndex];
 const listRequest=useRef(0);
 const loadList=async(p=page)=>{const seq=++listRequest.current;const value=await api<List>(`/desktop-after-sales?keyword=${encodeURIComponent(keyword)}&page=${p}&sort=${encodeURIComponent(sort.key)}&direction=${sort.direction}`);if(seq===listRequest.current)setList(value);};
 useEffect(()=>{let active=true;const timer=setInterval(()=>{if(active)void loadList().catch(()=>undefined);},5000);return()=>{active=false;clearInterval(timer);listRequest.current++;};},[keyword,page,sort.key,sort.direction]);
 useEffect(()=>{setPage(1);void loadList(1).catch(e=>setError(e.message));},[sort.key,sort.direction]);
 const accept=(v:DesktopSaleArchive)=>{draftVersion.current=v.version;selectedRef.current=v;setSelected(v);setProgress(v.progress);setOwner(v.ownerId?String(v.ownerId):'');setNextAt(localDate(v.nextAt));dirty.current=false;metadataDirty.current=false;setNote('');setPriority(v.priority??0);setRowColor(v.rowColor??'');setReport(v.report??'');};
 const acceptAttachment=(v:DesktopSaleArchive)=>{
  const current=selectedRef.current;if(!current||current.id!==v.id||v.version<current.version)return;
  if(!dirty.current){accept(v);return;}
  if(v.version===current.version){selectedRef.current=v;setSelected(v);return;}
  const sameFollow=current.progress===v.progress&&current.ownerId===v.ownerId&&current.nextAt===v.nextAt;
  if(draftVersion.current===current.version&&v.version===current.version+1&&sameFollow&&current.priority===v.priority&&current.rowColor===v.rowColor&&current.report===v.report)draftVersion.current=v.version;
  else setError('上传期间档案被其他人更新，请点击刷新版本核对处理进度，本次记录会保留。');
  selectedRef.current=v;setSelected(v);
 };
 async function run(action:()=>Promise<void>){setBusy(true);setError('');try{await action();}catch(e){setError((e as Error).message.replace(/^Error invoking remote method .*?Error: /,''));}finally{setBusy(false);}}
 const select=async(id:number)=>{
  if(dirty.current&&!confirm('当前有未保存的跟进内容，确定切换售后吗？'))return;
  const sequence=++request.current;
  await run(async()=>{const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${id}`);if(sequence===request.current)accept(v);});
 };
 useEffect(()=>{run(async()=>{setOptions(await api<Options>('/desktop-after-sales/options'));await loadList(1);if(bridge?.preferences){const prefs=await bridge.preferences();setShortcut(prefs.shortcut);setLocalEnabled(!!prefs.collection?.enabled);if(!prefs.registered)setError('截图快捷键未注册，请在桌面设置中更换快捷键。');}});},[]);
 useEffect(()=>{refreshCollection();},[refreshCollection]);
 useEffect(()=>{if(!bridge||!portal||!viewport.current)return;const el=viewport.current;
  const sync=()=>{const r=el.getBoundingClientRect();bridge.mount({x:r.x,y:r.y,width:r.width,height:r.height}).catch(e=>setError(e.message));};
  const observer=new ResizeObserver(sync);observer.observe(el);window.addEventListener('resize',sync);window.addEventListener('scroll',sync,true);sync();
  return()=>{observer.disconnect();window.removeEventListener('resize',sync);window.removeEventListener('scroll',sync,true);void bridge.hide();};
 },[bridge,portal]);
 useEffect(()=>()=>{void bridge?.context(null);},[bridge]);
 useEffect(()=>{void bridge?.context(selected?{id:selected.id,afterSaleId:selected.snapshot.afterSaleId}:null);},[bridge,selected?.id]);
 useEffect(()=>{if(!bridge)return;return bridge.onScreenshot(s=>{
  const current=selectedRef.current;
  if(!current||s.id!==current.id||s.afterSaleId!==current.snapshot.afterSaleId){setError('截图对应的售后已切换，未上传。截图已复制，可在对应档案手动粘贴。');return;}
  void run(async()=>{const blob=await(await fetch(s.image)).blob();const form=new FormData();form.append('file',blob,`售后-${s.afterSaleId}-${Date.now()}.png`);
   const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${s.id}/files`,{method:'POST',form});
   // Attachment must not erase an unsaved draft or apply to a newly selected case.
   acceptAttachment(v);await loadList();
  });
 });},[bridge]);
 const importSnapshot=()=>run(async()=>{
  if(!snapshot||!storeId||!company.trim())throw new Error('请选择售后、OA店铺，并确认聚水潭公司名称');
  if(dirty.current&&!confirm('建档将切换当前售后，放弃未保存的跟进内容吗？'))return;
  const v=await api<DesktopSaleArchive>('/desktop-after-sales/import',{method:'POST',body:{storeId:Number(storeId),snapshot:{...snapshot,sourceCompany:company.trim()}}});accept(v);await loadList();setSnapshots([]);
 });
 const save=()=>run(async()=>{if(!selected)return;
  const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}/follow`,{method:'POST',body:{version:draftVersion.current,progress,ownerId:owner?Number(owner):null,nextAt:nextAt?new Date(nextAt).toISOString():null,note}});const pending=metadataDirty.current?{priority,rowColor,report}:null;accept(v);if(pending){setPriority(pending.priority);setRowColor(pending.rowColor);setReport(pending.report);metadataDirty.current=true;dirty.current=true;}await loadList();
 });
 const upload=(file:File)=>run(async()=>{if(!selected)return;const id=selected.id;const form=new FormData();form.append('file',file);const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${id}/files`,{method:'POST',form});acceptAttachment(v);});
 const localQuery=async(p=1,explicitValue=keyword,kind=localKind)=>{
  if(!bridge?.query)throw new Error('请升级桌面客户端后使用本机查询');
  const firm=source?.sourceCompany||selectedRef.current?.snapshot.sourceCompany;
  const configured=sources.find(s=>s.sourceCompany===firm);if(!configured)throw new Error('请先在采集连接中核对聚水潭公司并保存来源');
  if(kind==='history'&&!/^\d{4,80}$/.test(explicitValue))throw new Error('历史售后请填写完整售后单号或内部订单号，在本机定向查询');
  const result=await bridge.query({kind,field:searchField,value:explicitValue,sourceCompany:firm!,page:p});
  await api(`/desktop-after-sales-collection/${configured.id}/local`,{body:{records:result.records}});
  setLocalPage(p);setLocalHasNext(!!result.hasNext);setLocalResult(true);await loadList(1);setPage(1);
  if(selectedRef.current){const current=selectedRef.current;acceptAttachment(await api<DesktopSaleArchive>(`/desktop-after-sales/${current.id}`));}
 };
 const readOrder=async(record=selected)=>{
  if(!record||!bridge)return;
  if(bridge.query){let found=await bridge.query({kind:localKind,field:'afterSaleId',value:record.snapshot.afterSaleId,sourceCompany:record.snapshot.sourceCompany,page:1});if(!found.records.length)found=await bridge.query({kind:localKind==='current'?'history':'current',field:'afterSaleId',value:record.snapshot.afterSaleId,sourceCompany:record.snapshot.sourceCompany,page:1});if(!found.records.length)throw new Error('原系统未找到此售后，请展开原页面核对');}
  await bridge.openOrder(record.snapshot.internalOrderId);
  // Legacy clients still open the original order. New clients keep the source hidden and read its detail.
  if(bridge.query){
   let found:DesktopSaleSnapshot|undefined;
   for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,400));const values=await bridge.read();found=values.find(s=>s.afterSaleId===record.snapshot.afterSaleId&&s.fields['订单操作日志']);if(found)break;}
   if(!found)throw new Error('订单详情尚未读完，请展开原单核对后点击读取当前页面');
   const v=await api<DesktopSaleArchive>('/desktop-after-sales/import',{body:{snapshot:found}});acceptAttachment(v);setTab('source');
  }
 };
 const configure=()=>run(async()=>{
  if(!bridge?.collection||!bridge.prepare)throw new Error('请升级客户端后启用本机采集');
  const connected=await bridge.prepare();if(connected.sourceCompany!==company.trim())throw new Error('请重新读取并核对当前已登录的聚水潭公司');
  if(!company.trim())throw new Error('请核对原页面显示的聚水潭公司');
  if(!confirm(`确认将聚水潭「${company.trim()}」的最新售后补采到当前 OA 公司？`))return;
  const configured=await api<{id:number}>('/desktop-after-sales-collection',{body:{sourceCompany:company.trim(),enabled:true,intervalSeconds:60}});

  await bridge.collection({enabled:true,sourceCompany:company.trim()});setLocalEnabled(true);setSourceId(String(configured.id));refreshCollection();
 });
 return <div className="desktop-sales">
  <header><div><h2>售后工作台</h2><p>最新申请在前 · 原单资料与 OA 跟进统一留档</p></div><div className="ds-actions"><button onClick={()=>setColumnSettings(v=>!v)}><Settings2 size={15}/> 列设置</button><button onClick={()=>setSettings(true)}>采集连接</button>{bridge&&<><button onClick={()=>run(async()=>{const v=await bridge.read();setSnapshots(v);setSnapshotIndex(0);if(v[0]?.sourceCompany)setCompany(v[0].sourceCompany);if(!v.length)throw new Error('当前页面未读到售后');})}>读取当前页面</button><button onClick={()=>setPortal(true)}><ExternalLink size={15}/> 展开聚水潭</button><button onClick={()=>run(async()=>{await bridge.screenshot(selected?{id:selected.id,afterSaleId:selected.snapshot.afterSaleId}:null);})}>截图 / 标注</button></>}</div></header>
  <DesktopCollectionStatus onSettings={()=>setSettings(true)} onRefresh={refreshCollection}/>
  {error&&<div role="alert" className="ds-error">{error}<button onClick={()=>setError('')}>关闭</button></div>}
  {!bridge&&<div className="ds-notice">网页可查看档案和继续处理。本机聚水潭查询及协同补采请使用桌面客户端。</div>}
  <section className="ds-list-tools"><form className="ds-search" onSubmit={e=>{e.preventDefault();setLocalResult(false);setPage(1);void run(()=>loadList(1));}}><select aria-label="搜索类型" value={searchField} onChange={e=>setSearchField(e.target.value as 'afterSaleId'|'internalOrderId')}><option value="afterSaleId">售后单号</option><option value="internalOrderId">内部订单号</option></select><input aria-label="搜索售后单号或内部订单号" placeholder="输入订单号查询 OA 档案" value={keyword} onChange={e=>setKeyword(e.target.value)}/><button disabled={busy}><Search size={14}/> 搜索 OA</button><button type="button" disabled={busy} onClick={()=>run(()=>loadList())}>刷新列表</button></form>
   {bridge&&<div className="ds-actions"><select aria-label="查询来源公司" value={sourceId} onChange={e=>setSourceId(e.target.value)}><option value="">选择聚水潭公司</option>{sources.map(s=><option key={s.id} value={s.id}>{s.sourceCompany}</option>)}</select><select aria-label="本机查询范围" value={localKind} onChange={e=>{setLocalKind(e.target.value as 'current'|'history');setLocalResult(false);}}><option value="current">当前售后</option><option value="history">历史售后</option></select><button disabled={busy} onClick={()=>run(()=>localQuery(1))}>本机查询并更新 OA</button>{localResult&&<><span>原页面第 {localPage} 页</span><button disabled={busy||localPage===1} onClick={()=>run(()=>localQuery(localPage-1))}>本机上一页</button><button disabled={busy||!localHasNext} onClick={()=>run(()=>localQuery(localPage+1))}>本机下一页</button></>}</div>}
  </section>
  {columnSettings&&<section className="ds-column-settings"><strong>显示列及顺序</strong><p>使用上下按钮调整列顺序；售后单号始终保留。点击申请时间、单号、负责人、紧急度表头可对全部归档排序，默认按申请时间倒序。</p><div>{BASE_COLUMNS.map(k=><label key={k}><input type="checkbox" checked={columns.includes(k)} disabled={k==='售后单号'} onChange={e=>setColumnPreferences(e.target.checked?[...columns,k]:columns.filter(v=>v!==k))}/>{k}</label>)}</div><ol>{columns.map((k,i)=><li key={k}>{k}<button aria-label={`${k}前移`} disabled={i===0} onClick={()=>{const next=[...columns];[next[i-1],next[i]]=[next[i],next[i-1]];setColumnPreferences(next);}}><ArrowUp size={13}/></button><button aria-label={`${k}后移`} disabled={i===columns.length-1} onClick={()=>{const next=[...columns];[next[i],next[i+1]]=[next[i+1],next[i]];setColumnPreferences(next);}}><ArrowDown size={13}/></button></li>)}</ol><button onClick={()=>setColumnPreferences(DEFAULT_COLUMNS)}>恢复原列表默认列</button></section>}
  <div className="ds-table-wrap"><table className="ds-table"><thead><tr><th>序号</th>{columns.map(k=><th key={k}>{sortable.includes(k)?<button onClick={()=>setSort({key:k,direction:sort.key===k&&sort.direction==='desc'?'asc':'desc'})}>{k}{sort.key===k?(sort.direction==='desc'?' ↓':' ↑'):''}</button>:<span className="ds-column-label">{k}</span>}</th>)}<th>操作</th></tr></thead><tbody>{sortedRows.map((r,i)=><tr key={r.id} style={{backgroundColor:r.rowColor||undefined}} className={`ds-priority-${r.priority??0}`}><td>{(page-1)*30+i+1}</td>{columns.map(k=><td key={k}>{k==='售后单号'?<button className="ds-link" disabled={busy} onClick={()=>select(r.id)}>{r.afterSaleId}</button>:k==='内部订单号'?<button className="ds-link" disabled={busy||!bridge} onClick={()=>run(async()=>{if(dirty.current&&!confirm('放弃当前未保存内容并查看此订单？'))return;const value=await api<DesktopSaleArchive>(`/desktop-after-sales/${r.id}`);accept(value);await readOrder(value);})}>{r.internalOrderId}</button>:k==='紧急度'?<span className={`ds-urgency ds-urgency-${r.priority??0}`}>{cellValue(r,k)}</span>:<span>{cellValue(r,k)||'—'}</span>}</td>)}<td><button disabled={busy} onClick={()=>select(r.id)}>处理</button></td></tr>)}</tbody></table>{!list.rows.length&&<div className="ds-empty">暂无匹配售后。可连接聚水潭补采最新数据，或在本机查询指定历史订单。</div>}</div>
  <footer className="ds-pagination"><span>共 {list.total} 条 · {sort.key}{sort.direction==='desc'?'倒序':'正序'}</span><button disabled={busy||page===1} onClick={()=>run(async()=>{await loadList(page-1);setPage(page-1);})}>上一页</button><span>{page} / {Math.max(1,Math.ceil(list.total/30))}</span><button disabled={busy||page*30>=list.total} onClick={()=>run(async()=>{await loadList(page+1);setPage(page+1);})}>下一页</button></footer>
    {snapshots.length>0&&<section className="ds-import"><strong>读取结果 · {snapshots.length} 条</strong><label>选择售后<select value={snapshotIndex} onChange={e=>setSnapshotIndex(Number(e.target.value))}>{snapshots.map((s,i)=><option key={s.afterSaleId} value={i}>{s.afterSaleId} · 内部订单 {s.internalOrderId||'未读取'}</option>)}</select></label>
     <label>聚水潭公司（请核对）<input value={company} maxLength={100} onChange={e=>setCompany(e.target.value)} placeholder="例如：粮满满电商"/></label><label>关联 OA 店铺<select value={storeId} onChange={e=>setStoreId(e.target.value)}><option value="">请选择，确认与原单店铺一致</option>{options.stores.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><p>原单店铺：{snapshot?.fields['店铺']||'请在聚水潭核对'}</p><details className="ds-read-preview"><summary>查看已读取字段（{Object.keys(snapshot?.fields??{}).length}）</summary><dl>{Object.entries(snapshot?.fields??{}).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></details><button className="primary" disabled={busy||!snapshot?.internalOrderId} onClick={importSnapshot}>确认关联并保存到 OA</button><button onClick={()=>setSnapshots([])}>收起读取结果</button></section>}
    {selected&&<div className="ds-drawer-backdrop"><section className="ds-detail ds-drawer" role="dialog" aria-modal="true" aria-label={`售后 ${selected.snapshot.afterSaleId}`}><button disabled={busy} className="ds-close" aria-label="关闭售后详情" onClick={()=>{if(!dirty.current||confirm('放弃未保存的跟进内容？')){setSelected(null);selectedRef.current=null;}}}><X size={18}/></button><h3>售后 {selected.snapshot.afterSaleId}</h3><p>{selected.storeName} · 内部订单 <button className="ds-link" disabled={!bridge} onClick={()=>run(async()=>{await readOrder();})}>{selected.snapshot.internalOrderId}</button></p>
     <div className="ds-tabs"><button className={tab==='follow'?'chosen':''} onClick={()=>setTab('follow')}>OA 处理记录</button><button className={tab==='source'?'chosen':''} onClick={()=>setTab('source')}>聚水潭原始信息</button></div>
     {tab==='source'?<><p>来源：{selected.snapshot.sourceCompany} · 读取于 {new Date(selected.snapshot.capturedAt).toLocaleString()}</p><dl>{Object.entries(selected.snapshot.fields).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v||'—'}</dd></div>)}</dl><p>这里只展示已读取并保存的内容。详情或日志尚未读取时，请在原系统打开对应订单，再读取保存。</p></>:<>
      <label>处理到哪一步<input disabled={busy} maxLength={300} value={progress} onChange={e=>{dirty.current=true;setProgress(e.target.value);}} placeholder="例如：已联系买家，等待退回物流"/></label>
      <div className="ds-columns"><label>负责人<select disabled={busy} value={owner} onChange={e=>{dirty.current=true;setOwner(e.target.value);}}><option value="">未分配</option>{options.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>下次跟进时间<input disabled={busy} type="datetime-local" value={nextAt} onChange={e=>{dirty.current=true;setNextAt(e.target.value);}}/></label></div>
      <label>本次处理记录<textarea disabled={busy} value={note} maxLength={4000} onChange={e=>{dirty.current=true;setNote(e.target.value);}} placeholder="记录已做的处理、结果和下一步" rows={3}/></label>
      <div className="ds-actions"><button className="primary" disabled={busy||!note.trim()} onClick={save}>保存跟进</button><label className="ds-upload">上传凭证<input disabled={busy} type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value='';}}/></label><button disabled={busy} onClick={()=>run(async()=>{if(dirty.current&&!confirm('刷新会重载处理进度、颜色及报告，保留本次处理记录。继续吗？'))return;const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}`);const pendingNote=note;accept(v);setNote(pendingNote);dirty.current=!!pendingNote;})}>刷新版本</button></div>
      <p className="ds-help">跟进记录不会自动退款或确认收货。需要原单业务操作时，可展开内嵌聚水潭页面。</p>
      <details className="ds-tools"><summary>颜色、紧急度与跟踪报告</summary>
       <div className="ds-columns"><label>紧急度<select disabled={busy} value={priority} onChange={e=>{dirty.current=true;metadataDirty.current=true;setPriority(Number(e.target.value));}}>{PRIORITIES.map((v,i)=><option key={v} value={i}>{v}</option>)}</select></label><label>列表标记颜色<input disabled={busy} type="color" value={rowColor||'#ffffff'} onChange={e=>{dirty.current=true;metadataDirty.current=true;setRowColor(e.target.value);}}/></label></div><button onClick={()=>{dirty.current=true;metadataDirty.current=true;setRowColor('');}}>清除颜色</button>
       <label>跟踪报告<textarea disabled={busy} rows={5} maxLength={8000} value={report} onChange={e=>{dirty.current=true;metadataDirty.current=true;setReport(e.target.value);}} placeholder="事件经过、当前结果、待处理事项和结论"/></label><button disabled={busy} onClick={()=>run(async()=>{const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}/metadata`,{body:{version:draftVersion.current,priority,rowColor:rowColor||null,report}});selectedRef.current=v;setSelected(v);draftVersion.current=v.version;metadataDirty.current=false;dirty.current=!!note.trim()||progress!==v.progress||owner!==(v.ownerId?String(v.ownerId):'')||nextAt!==localDate(v.nextAt);await loadList();})}>保存标记与报告</button>
      </details>
      <details className="ds-tools"><summary>推送给其他部门继续处理</summary><label>协作人<select disabled={busy} value={recipient} onChange={e=>setRecipient(e.target.value)}><option value="">选择本公司人员</option>{options.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>交接说明<textarea disabled={busy} rows={3} maxLength={500} value={message} onChange={e=>setMessage(e.target.value)}/></label><button disabled={busy||!recipient||!message.trim()} onClick={()=>run(async()=>{await api(`/desktop-after-sales-shared/${selected.id}/share`,{body:{recipients:[Number(recipient)],message,canWrite:true}});setMessage('');acceptAttachment(await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}`));})}>推送售后并授权填写处理记录</button></details>
      <details className="ds-tools"><summary>按 OA 流程逐步办理</summary>{selected.flowRunId?<button onClick={()=>setFlowId(selected.flowRunId!)}>查看办理流程</button>:<><p>关联 OA 店铺后，可按公司已发布的售后流程办理，办理人和可执行操作由流程决定。</p><label>关联 OA 店铺<select value={storeId||selected.storeId||''} onChange={e=>setStoreId(e.target.value)}><option value="">请选择</option>{options.stores.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>售后类型<select value={caseType} onChange={e=>setCaseType(e.target.value)}>{[['other','其他'],['refund_only','仅退款'],['return_refund','退货退款'],['exchange','换货'],['resend','补发'],['compensation','补偿']].map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label><label>申请金额（元）<input type="number" min="0" step="0.01" value={flowAmount} onChange={e=>setFlowAmount(e.target.value)}/></label><label>流程申请说明<textarea maxLength={500} value={flowReason} onChange={e=>setFlowReason(e.target.value)}/></label><button disabled={busy||!flowReason.trim()} onClick={()=>run(async()=>{if(!selected.storeId){if(!storeId)throw new Error('请关联 OA 店铺');await api('/desktop-after-sales/import',{body:{storeId:Number(storeId),snapshot:selected.snapshot}});}const result=await api<{runId:number}>(`/desktop-after-sales-shared/${selected.id}/flow`,{body:{caseType,amountCents:Math.round(Number(flowAmount)*100),reason:flowReason}});setFlowId(result.runId);acceptAttachment(await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}`));})}>发起办理流程</button></>}</details>
      {selected.files.map(f=><button key={f.id} className="ds-file" onClick={()=>run(async()=>{const v=await api<{url:string}>(`/desktop-after-sales/${selected.id}/files/${f.id}/url`);window.open(v.url,'_blank','noopener');})}>{f.name}</button>)}
      <ol className="ds-history">{selected.events.map(e=><li key={e.id}><small>{e.actorName} · {new Date(e.createdAt).toLocaleString()}</small><p>{e.content}</p></li>)}</ol>{selected.nextEventsBefore&&<button disabled={busy} onClick={()=>run(async()=>{const value=await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}/events?before=${selected.nextEventsBefore}`);const current=selectedRef.current;if(current?.id===selected.id){const next={...current,events:[...current.events,...value.events],nextEventsBefore:value.nextEventsBefore};selectedRef.current=next;setSelected(next);}})}>加载更早处理历史</button>}
     </>}
    </section></div>}
  {settings&&<div className="ds-drawer-backdrop"><section className="ds-drawer" role="dialog" aria-modal="true" aria-label="采集连接"><button className="ds-close" aria-label="关闭采集连接" onClick={()=>setSettings(false)}><X size={18}/></button><h3>最新售后 · 多客户端接力补采</h3><p>同一来源每轮由一台电脑采集，掉线后其他客户端接续。只补采最新售后；历史订单在本机定向查询。</p><p>默认每 60 秒查询一次；原系统更新延迟、断网或登录失效会影响及时性。</p>
   {sources.map(s=><div className="ds-source-config" key={s.id}><strong>{s.sourceCompany}</strong><p>最后成功：{s.lastSuccessAt?new Date(s.lastSuccessAt).toLocaleString():'无'} · {s.enabled?'已启用':'已停止'}</p><button disabled={busy} onClick={()=>run(async()=>{await api('/desktop-after-sales-collection',{body:{sourceCompany:s.sourceCompany,enabled:!s.enabled,intervalSeconds:s.intervalSeconds}});refreshCollection();})}>{s.enabled?'停止此来源最新采集':'恢复此来源最新采集'}</button>{bridge?.collection&&<button disabled={busy} onClick={()=>run(async()=>{await bridge.collection!({enabled:!localEnabled,sourceCompany:s.sourceCompany});setLocalEnabled(!localEnabled);})}>{localEnabled?'本机退出协同采集':'本机参与该来源最新采集'}</button>}</div>)}
   {bridge&&<><button disabled={busy} onClick={()=>{setSettings(false);setPortal(true);}}>打开聚水潭登录 / 核对公司</button><button disabled={busy} onClick={()=>run(async()=>{if(!bridge.prepare)throw new Error('请升级客户端');const v=await bridge.prepare();setCompany(v.sourceCompany);if(!v.sourceCompany)throw new Error('尚未识别公司，请先在原页面登录');})}>读取本机已登录公司</button><label>聚水潭公司（请核对）<input value={company} maxLength={100} onChange={e=>setCompany(e.target.value)}/></label><button className="primary" disabled={busy||!company.trim()} onClick={configure}>确认公司并启用最新补采</button><hr/><label>全局截图快捷键<input value={shortcut} onChange={e=>setShortcut(e.target.value)}/></label><button onClick={()=>run(async()=>{await bridge.shortcut(shortcut);})}>保存快捷键</button><button onClick={()=>{if(confirm('退出本机聚水潭并停止本机补采？其他已登录客户端可继续接力。'))void run(async()=>{await bridge.clearLogin();setLocalEnabled(false);});}}>退出聚水潭登录</button></>}
  </section></div>}
  {portal&&bridge&&<div className="ds-native-overlay"><div className="ds-native-title"><strong>聚水潭 · 本机内嵌页面</strong><span>关闭后返回 OA 售后工作台</span><button disabled={busy} onClick={()=>run(async()=>{await bridge.refresh();})}>刷新聚水潭</button><button disabled={busy} onClick={()=>run(async()=>{const v=await bridge.read();setSnapshots(v);setSnapshotIndex(0);if(v[0]?.sourceCompany)setCompany(v[0].sourceCompany);setPortal(false);if(!v.length)throw new Error('当前页面未读到售后，请打开售后列表或内部订单详情后重试');})}>读取当前页面</button><button onClick={()=>setPortal(false)}>关闭原页面</button></div><div className="ds-viewport" ref={viewport}/></div>}
  {flowId&&<div className="ds-flow"><RunDetail id={flowId} onClose={()=>setFlowId(null)} onChanged={()=>{if(selected)void run(async()=>acceptAttachment(await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}`)));}}/></div>}
 </div>;
}
