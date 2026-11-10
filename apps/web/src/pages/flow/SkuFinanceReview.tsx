import {useEffect,useRef,useState} from 'react';
import {FileCheck2,RefreshCw} from 'lucide-react';
import {api,ApiError} from '../../api/client';
import './skuFinanceReview.css';
interface Issue {level:'difference'|'confirm'|'unknown';title:string;detail:string;keys:string[];roles:string[]}
interface Row {key:string;runId:number;name:string;platform:string;mainNetG:number|null;giftWeightG:number|null;materialWeightG:number|null;weightG:number|null;cost:number|null;sale:number|null;unitSale:number|null;priceSource:string;lines:Array<{role:string;name:string;qty:number;cost:number|null}>}
interface Result {rows:Row[];issues:Issue[];capturedAt:string;revision:number;canPrice:boolean;excluded:boolean;semanticStatus:string}
const money=(v:number|null)=>v===null?'资料不足':`¥${(v/100).toFixed(2)}`;
const weight=(v:number|null)=>v===null?'资料不足':`${Number(v.toFixed(6))}克`;
export function SkuFinanceReview({runId,revision}:{runId:number;revision:number}){
 const [result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[filter,setFilter]=useState('all'),[focus,setFocus]=useState<string[]>([]),[focusRoles,setFocusRoles]=useState<string[]>([]),[stale,setStale]=useState(false);
 const version=useRef(0),host=useRef<HTMLElement>(null);
 useEffect(()=>{version.current++;setResult(null);setError('');setBusy(false);setStale(false);return()=>{version.current++;};},[runId,revision]);
 useEffect(()=>{const mark=()=>setStale(true);window.addEventListener('focus',mark);return()=>window.removeEventListener('focus',mark);},[]);
 async function check(){const token=++version.current;setBusy(true);setError('');try{const next=await api<Result>(`/flow/sku-apply/runs/${runId}/finance-review`);if(token!==version.current)return;setResult(next);setStale(next.revision!==revision);setFocus([]);}catch(e){if(token===version.current){setError(e instanceof ApiError?e.message:'核对暂不可用，请重试；原审核操作不受影响');setStale(true);}}finally{if(token===version.current)setBusy(false);}}
 function locate(issue:Issue){setFocus(issue.keys);setFocusRoles(issue.roles);host.current?.querySelector('[data-review-table]')?.scrollIntoView?.({behavior:'smooth',block:'nearest'});}
 return <section className="sku-finance-review" ref={host} aria-label="财务一键核对">
  <header><div><strong>数量、重量与价格核对</strong><small>仅提醒，原审核操作不受影响</small></div><button type="button" disabled={busy} onClick={()=>void check()}>{result?<RefreshCw size={16}/>:<FileCheck2 size={16}/>} {busy?'正在核对…':result?'重新核对':'一键核对'}</button></header>
  {error&&<p role="alert">{error}</p>}
  {result&&<><div className="sku-review-summary" role="status">{(['difference','confirm','unknown'] as const).map((level,i)=><button type="button" aria-pressed={filter===level} key={level} onClick={()=>setFilter(filter===level?'all':level)}>{['明确不一致','建议确认','资料不足'][i]} {result.issues.filter(x=>x.level===level).length}</button>)}<small>核对 {result.rows.length} 个规格 · {new Date(result.capturedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</small></div>
   {stale&&<p className="sku-review-unknown">结果可能已过期，请重新核对。</p>}
   {result.excluded&&<p>部分规格不可见或超过本次范围，仅对下表资料核对。</p>}
   {result.semanticStatus!=='done'&&<p className="sku-review-unknown">已完成规则核对；名称和备注的智能核对暂不可用，请人工确认。</p>}
   {!result.issues.length&&<p>本次未发现可识别的异常，仍请按原流程人工审核。</p>}
   <div className="sku-review-issues">{result.issues.filter(x=>filter==='all'||x.level===filter).map((issue,i)=><article className={`sku-review-${issue.level}`} key={i}><button type="button" onClick={()=>locate(issue)}>{issue.title}<span>查看对应规格 ↓</span></button><p>{issue.detail}</p><small>{result.rows.filter(r=>issue.keys.includes(r.key)).map(r=>r.name).join(' / ')}</small></article>)}</div>
   <div className="sku-review-table" data-review-table><table><thead><tr><th>规格／主品数量</th><th>主品净含量</th><th>发货总重</th><th>成本</th>{result.canPrice&&<><th>售价／参考价</th><th>每公斤价格</th></>}</tr></thead><tbody>{result.rows.map(row=><tr key={row.key} className={focus.includes(row.key)?'focused':''}><td><strong>{row.name}</strong>{row.lines.filter(l=>l.role==='main').map((l,i)=><small key={i}>{l.name} × {l.qty}</small>)}</td><td>{weight(row.mainNetG)}</td><td>{weight(row.weightG)}<small>赠品 {weight(row.giftWeightG)}</small><small>包装物料 {weight(row.materialWeightG)}</small></td><td>{money(row.cost)}<details open={focus.includes(row.key)&&focusRoles.length>0?true:undefined}><summary>成本组成</summary>{row.lines.map((l,i)=><small className={focus.includes(row.key)&&focusRoles.includes(l.role)?'sku-review-line-focus':''} key={i}>{l.name} × {l.qty}：{money(l.cost)}</small>)}</details></td>{result.canPrice&&<><td>{row.sale===null?'暂不可比':money(row.sale)}<small>{row.priceSource}</small></td><td>{row.unitSale===null?'—':money(row.unitSale)}</td></>}</tr>)}</tbody></table></div>
   <small className="sku-review-source">优先使用运营明确注明的售价；未注明时，参考售价取聚水潭普通商品镜像，按物料数量汇总，不含赠品、人工；不是店铺成交价。仅比较同款、同品牌、同平台、同场景且赠品一致的规格。</small>
  </>}
 </section>;
}
