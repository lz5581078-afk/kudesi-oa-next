import {useEffect,useRef,useState} from 'react';
import type {DesktopSaleArchive,DesktopSaleSnapshot} from '@kudesi/shared';
import {api} from '../../api/client';
import './desktopAfterSales.css';
type Shot={id:number;afterSaleId:string;image:string};
interface DesktopBridge {
 version:string;preferences():Promise<{shortcut:string;registered:boolean}>;zoom(value:number):Promise<boolean>;
 mount(bounds:{x:number;y:number;width:number;height:number}):Promise<boolean>;
 hide():Promise<boolean>;refresh():Promise<boolean>;read():Promise<DesktopSaleSnapshot[]>;
 openOrder(id:string):Promise<boolean>;screenshot(context:{id:number;afterSaleId:string}|null):Promise<boolean>;
 context(context:{id:number;afterSaleId:string}|null):Promise<boolean>;
 shortcut(value:string):Promise<boolean>;clearLogin():Promise<boolean>;
 onScreenshot(callback:(s:Shot)=>void):()=>void;
}
declare global {interface Window {oaDesktop?:DesktopBridge}}
type Options={stores:Array<{id:number;name:string}>;people:Array<{id:number;name:string}>};
type List={total:number;rows:Array<{id:number;afterSaleId:string;internalOrderId:string;sourceCompany:string;progress:string;nextAt:string|null}>};
const localDate=(value:string|null)=>{if(!value)return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
export function DesktopAfterSalesPage(){
 const bridge=window.oaDesktop,viewport=useRef<HTMLDivElement>(null),selectedRef=useRef<DesktopSaleArchive|null>(null),request=useRef(0);
 const [options,setOptions]=useState<Options>({stores:[],people:[]}),[list,setList]=useState<List>({total:0,rows:[]});
 const [selected,setSelected]=useState<DesktopSaleArchive|null>(null),[snapshots,setSnapshots]=useState<DesktopSaleSnapshot[]>([]),[snapshotIndex,setSnapshotIndex]=useState(0);
 const [storeId,setStoreId]=useState(''),[company,setCompany]=useState(''),[keyword,setKeyword]=useState(''),[page,setPage]=useState(1);
 const [progress,setProgress]=useState(''),[owner,setOwner]=useState(''),[nextAt,setNextAt]=useState(''),[note,setNote]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[tab,setTab]=useState<'follow'|'source'>('follow'),[shortcut,setShortcut]=useState('CommandOrControl+Shift+S');
 const dirty=useRef(false),draftVersion=useRef(0);const snapshot=snapshots[snapshotIndex];
 const loadList=async(p=page)=>setList(await api<List>(`/desktop-after-sales?keyword=${encodeURIComponent(keyword)}&page=${p}`));
 const accept=(v:DesktopSaleArchive)=>{draftVersion.current=v.version;selectedRef.current=v;setSelected(v);setProgress(v.progress);setOwner(v.ownerId?String(v.ownerId):'');setNextAt(localDate(v.nextAt));dirty.current=false;setNote('');};
 const acceptAttachment=(v:DesktopSaleArchive)=>{
  const current=selectedRef.current;if(!current||current.id!==v.id||v.version<current.version)return;
  if(!dirty.current){accept(v);return;}
  const sameFollow=current.progress===v.progress&&current.ownerId===v.ownerId&&current.nextAt===v.nextAt;
  if(draftVersion.current===current.version&&v.version===current.version+1&&sameFollow)draftVersion.current=v.version;
  else setError('上传期间档案被其他人更新，请点击刷新版本核对处理进度，本次记录会保留。');
  selectedRef.current=v;setSelected(v);
 };
 async function run(action:()=>Promise<void>){setBusy(true);setError('');try{await action();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const select=async(id:number)=>{
  if(dirty.current&&!confirm('当前有未保存的跟进内容，确定切换售后吗？'))return;
  const sequence=++request.current;
  await run(async()=>{const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${id}`);if(sequence===request.current)accept(v);});
 };
 useEffect(()=>{run(async()=>{setOptions(await api<Options>('/desktop-after-sales/options'));await loadList(1);if(bridge?.preferences){const prefs=await bridge.preferences();setShortcut(prefs.shortcut);if(!prefs.registered)setError('截图快捷键未注册，请在桌面设置中更换快捷键。');}});},[]);
 useEffect(()=>{if(!bridge||!viewport.current)return;const el=viewport.current;
  const sync=()=>{const r=el.getBoundingClientRect();bridge.mount({x:r.x,y:r.y,width:r.width,height:r.height}).catch(e=>setError(e.message));};
  const observer=new ResizeObserver(sync);observer.observe(el);window.addEventListener('resize',sync);window.addEventListener('scroll',sync,true);sync();
  return()=>{observer.disconnect();window.removeEventListener('resize',sync);window.removeEventListener('scroll',sync,true);void bridge.hide();};
 },[bridge]);
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
  const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}/follow`,{method:'POST',body:{version:draftVersion.current,progress,ownerId:owner?Number(owner):null,nextAt:nextAt?new Date(nextAt).toISOString():null,note}});accept(v);await loadList();
 });
 const upload=(file:File)=>run(async()=>{if(!selected)return;const id=selected.id;const form=new FormData();form.append('file',file);const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${id}/files`,{method:'POST',form});acceptAttachment(v);});
 return <div className="desktop-sales">
  <header><div><h2>售后工作台</h2><p>聚水潭处理原单，OA记录处理进度与凭证。</p></div><div className="ds-actions">
   {bridge&&<><button disabled={busy} onClick={()=>run(async()=>{await bridge.refresh();})}>刷新聚水潭</button><button disabled={busy} onClick={()=>run(async()=>{const v=await bridge.read();setSnapshots(v);setSnapshotIndex(0);if(v[0]?.sourceCompany)setCompany(v[0].sourceCompany);if(!v.length)throw new Error('当前页面未读到售后，请打开聚水潭售后列表或内部订单详情后重试');})}>读取当前页面</button><button onClick={()=>run(async()=>{await bridge.screenshot(selected?{id:selected.id,afterSaleId:selected.snapshot.afterSaleId}:null);})}>截图 / 标注</button></>}
  </div></header>
  {error&&<div role="alert" className="ds-error">{error}<button onClick={()=>setError('')}>关闭</button></div>}
  {!bridge&&<div className="ds-notice">请使用酷得斯 OA 桌面客户端打开聚水潭、读取页面和使用快捷截图。此处可查看已建档售后并继续跟进。</div>}
  <div className={`ds-layout ${bridge?'':'ds-browser'}`}>
   {bridge&&<section className="ds-platform"><div className="ds-platform-title">聚水潭 · 原系统 <span><select aria-label="聚水潭页面缩放" defaultValue="0.8" onChange={e=>run(async()=>{await bridge.zoom(Number(e.target.value));})}>{[0.6,0.7,0.8,0.9,1].map(v=><option key={v} value={v}>{Math.round(v*100)}%</option>)}</select> 登录状态仅保存在此电脑</span></div><div className="ds-viewport" ref={viewport}/></section>}
   <aside className="ds-panel">
    {snapshots.length>0&&<section className="ds-import"><strong>读取结果 · {snapshots.length} 条</strong><label>选择售后<select value={snapshotIndex} onChange={e=>setSnapshotIndex(Number(e.target.value))}>{snapshots.map((s,i)=><option key={s.afterSaleId} value={i}>{s.afterSaleId} · 内部订单 {s.internalOrderId||'未读取'}</option>)}</select></label>
     <label>聚水潭公司（请核对）<input value={company} maxLength={100} onChange={e=>setCompany(e.target.value)} placeholder="例如：粮满满电商"/></label><label>关联 OA 店铺<select value={storeId} onChange={e=>setStoreId(e.target.value)}><option value="">请选择，确认与原单店铺一致</option>{options.stores.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><p>原单店铺：{snapshot?.fields['店铺']||'请在聚水潭核对'}</p><details className="ds-read-preview"><summary>查看已读取字段（{Object.keys(snapshot?.fields??{}).length}）</summary><dl>{Object.entries(snapshot?.fields??{}).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></details><button className="primary" disabled={busy||!snapshot?.internalOrderId} onClick={importSnapshot}>确认关联并保存到 OA</button><button onClick={()=>setSnapshots([])}>收起读取结果</button></section>}
    <section><form className="ds-search" onSubmit={e=>{e.preventDefault();setPage(1);void run(()=>loadList(1));}}><input aria-label="搜索售后单号或内部订单号" placeholder="售后单号 / 内部订单号" value={keyword} onChange={e=>setKeyword(e.target.value)}/><button disabled={busy}>搜索</button></form>
     <div className="ds-archive-list">{list.rows.map(r=><button key={r.id} className={selected?.id===r.id?'chosen':''} disabled={busy} onClick={()=>select(r.id)}><strong>{r.afterSaleId}</strong><span>{r.progress||'尚未填写处理进度'}</span><small>{r.sourceCompany} · {r.internalOrderId}{r.nextAt?` · 下次 ${new Date(r.nextAt).toLocaleString()}`:''}</small></button>)}{!list.rows.length&&<p>尚无建档记录。读取聚水潭售后后确认店铺并保存。</p>}</div>
     {list.total>30&&<div className="ds-actions"><button disabled={busy||page===1} onClick={()=>run(async()=>{await loadList(page-1);setPage(page-1);})}>上一页</button><span>{page} / {Math.ceil(list.total/30)}</span><button disabled={busy||page*30>=list.total} onClick={()=>run(async()=>{await loadList(page+1);setPage(page+1);})}>下一页</button></div>}
    </section>
    {selected&&<section className="ds-detail"><h3>售后 {selected.snapshot.afterSaleId}</h3><p>{selected.storeName} · 内部订单 <button className="ds-link" disabled={!bridge} onClick={()=>run(async()=>{await bridge!.openOrder(selected.snapshot.internalOrderId);})}>{selected.snapshot.internalOrderId}</button></p>
     <div className="ds-tabs"><button className={tab==='follow'?'chosen':''} onClick={()=>setTab('follow')}>OA 处理记录</button><button className={tab==='source'?'chosen':''} onClick={()=>setTab('source')}>聚水潭原始信息</button></div>
     {tab==='source'?<><p>来源：{selected.snapshot.sourceCompany} · 读取于 {new Date(selected.snapshot.capturedAt).toLocaleString()}</p><dl>{Object.entries(selected.snapshot.fields).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v||'—'}</dd></div>)}</dl><p>这里只展示已读取并保存的内容。详情或日志尚未读取时，请在原系统打开对应订单，再读取保存。</p></>:<>
      <label>处理到哪一步<input disabled={busy} maxLength={300} value={progress} onChange={e=>{dirty.current=true;setProgress(e.target.value);}} placeholder="例如：已联系买家，等待退回物流"/></label>
      <div className="ds-columns"><label>负责人<select disabled={busy} value={owner} onChange={e=>{dirty.current=true;setOwner(e.target.value);}}><option value="">未分配</option>{options.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>下次跟进时间<input disabled={busy} type="datetime-local" value={nextAt} onChange={e=>{dirty.current=true;setNextAt(e.target.value);}}/></label></div>
      <label>本次处理记录<textarea disabled={busy} value={note} maxLength={4000} onChange={e=>{dirty.current=true;setNote(e.target.value);}} placeholder="记录已做的处理、结果和下一步" rows={3}/></label>
      <div className="ds-actions"><button className="primary" disabled={busy||!note.trim()} onClick={save}>保存跟进</button><label className="ds-upload">上传凭证<input disabled={busy} type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value='';}}/></label><button disabled={busy} onClick={()=>run(async()=>{if(dirty.current&&!confirm('重新加载最新处理进度、负责人和时间，保留本次处理记录。继续吗？'))return;const v=await api<DesktopSaleArchive>(`/desktop-after-sales/${selected.id}`);const pendingNote=note;accept(v);setNote(pendingNote);dirty.current=!!pendingNote;})}>刷新版本</button></div>
      <p className="ds-help">跟进记录不会自动退款或确认收货。原单业务处理请使用左侧聚水潭按钮。</p>
      {selected.files.map(f=><button key={f.id} className="ds-file" onClick={()=>run(async()=>{const v=await api<{url:string}>(`/desktop-after-sales/${selected.id}/files/${f.id}/url`);window.open(v.url,'_blank','noopener');})}>{f.name}</button>)}
      <ol className="ds-history">{selected.events.map(e=><li key={e.id}><small>{e.actorName} · {new Date(e.createdAt).toLocaleString()}</small><p>{e.content}</p></li>)}</ol>
     </>}
    </section>}
    {bridge&&<details className="ds-settings"><summary>桌面设置</summary><label>全局截图快捷键<input value={shortcut} onChange={e=>setShortcut(e.target.value)}/></label><button onClick={()=>run(async()=>{await bridge.shortcut(shortcut);})}>保存快捷键</button><button onClick={()=>{if(confirm('退出本机聚水潭登录？下次需重新登录。'))void run(async()=>{await bridge.clearLogin();setSnapshots([]);});}}>退出聚水潭登录</button></details>}
   </aside>
  </div>
 </div>;
}
