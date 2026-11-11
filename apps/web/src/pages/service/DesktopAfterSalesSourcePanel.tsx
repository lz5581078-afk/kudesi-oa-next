import { useState } from 'react';
import type { DesktopSaleSnapshot } from '@kudesi/shared';
import './desktopAfterSalesSource.css';
import type {DesktopSourcePanelSnapshot} from './desktopBridge';
import {AfterSalesProductImage} from './AfterSalesProductImage';

const GOODS_HEADERS = [
  '商品信息', '商品名称', '商品编码', '商品简称', '款式编码', '款编码', 'SKU', '规格', '颜色', '尺码',
  '类型', '单价', '数量', '申请数量', '申请退货数量', '退货数量', '换货数量', '实退数量', '退款金额',
  '申请退款金额', '实退金额', '实收数量/金额', '实收数量', '实收金额', '实际收货数量', '实际收货金额',
  '次品数量', '线上金额', '备注', '原订单单价/采购价', '原订单单价', '原订单采购价', '进仓时间',
  '入库时间', '金额', '商品金额', '实付金额', '售价',
];
const REFUND_FIELDS = [
  '商品应退金额', '卖家应退运费', '应退运费', '优惠/差额', '优惠／差额', '优惠差额', '卖家应补',
  '换货金额', '买家应补运费', '买家应补', '商家实退', '实退金额',
];
const LOG_HEADERS = ['时间', '操作时间', '操作人', '操作', '修改内容'];
const TRACKING_HEADERS = [
  '时间', '物流时间', '更新时间', '状态', '物流状态', '物流描述', '物流信息', '物流详情',
  '地点', '描述', '内容', '物流轨迹', '查询结果',
  '详情',
];
const PLATFORM_FIELDS = [
  '线上售后单号', '线上订单号', '平台', '店铺', '线上状态', '线上类型', '申请时间',
  '退款原因', '拒绝原因', '处理结果', '备注',
];

const GOODS_COLUMNS = [
  '商品信息', '商品简称', '类型', '单价', '申请数量', '退款金额', '实收数量/金额',
  '次品数量', '线上金额', '备注', '原订单单价/采购价', '进仓时间', '操作',
];
const REFUND_COLUMNS = ['商品应退金额', '应退运费', '卖家应补', '优惠/差额', '换货金额', '买家应补', '实退金额'];
const LOG_COLUMNS = ['时间', '操作人', '操作', '修改内容'];
const REFUND_ALIASES: Record<string,string> = {
  卖家应退运费: '应退运费', '优惠／差额': '优惠/差额', 优惠差额: '优惠/差额',
  买家应补运费: '买家应补', 商家实退: '实退金额',
};
export const SOURCE_PANELS = {
  goods: {label:'商品明细', field:'售后商品明细', title:'商品明细', headers:GOODS_HEADERS},
  refund: {label:'查看明细', field:'实退金额明细', title:'实退金额明细', headers:REFUND_FIELDS},
  logs: {label:'查看日志', field:'售后日志', title:'查看日志', headers:LOG_HEADERS},
  tracking: {label:'查看退货物流', field:'退货物流明细', title:'物流（快递）跟踪信息', headers:TRACKING_HEADERS},
  shipping: {label:'查看发货物流', field:'发货物流明细', title:'物流（快递）跟踪信息', headers:TRACKING_HEADERS},
  orderAmount: {label:'订单金额明细', field:'原订单下单金额明细', title:'原订单下单金额', headers:[]},
  refusal: {label:'查看', field:'拒绝原因明细', title:'拒绝原因', headers:[]},
  platform: {label:'查看平台售后单详情', field:'平台售后记录', title:'平台售后详情', headers:PLATFORM_FIELDS},
} as const;

type SourcePanelKind = keyof typeof SOURCE_PANELS;
type Entry = [label: string, value: string];
type PanelRows = { rows: Entry[][]; notes: string[] };

/** Preserve the displayed column order of each archived source row. Older text may contain wrapped cells. */
function parseRows(content: string, allowed: readonly string[], table=false): PanelRows {
  if (!allowed.length) return {rows:[],notes:content.trim()?[content]:[]};
  const headings = allowed.map(label=>label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(^|\\r?\\n|[ \\t]+·[ \\t]+)(${headings})[：:]`, 'g');
  const result: PanelRows = {rows: [], notes: []};
  let matches = [...content.matchAll(pattern)];
  if(table){
    // A product description can itself contain a line named 商品编码. Only the
    // table's first column starts a new record; labels inside a cell stay there.
    const first=matches.find(match=>!match[1].includes('·'))?.[2];
    matches=matches.filter(match=>match[1].includes('·')||match[2]===first);
  }
  const firstRow = matches.findIndex(match=>!match[1].includes('·'));
  if (firstRow < 0) {
    if (content.trim()) result.notes.push(content);
    return result;
  }
  const intro = content.slice(0,matches[firstRow].index).trim();
  if (intro) result.notes.push(intro);
  for (let index = firstRow; index < matches.length; index++) {
    const match = matches[index];
    const label = match[2];
    const value = content.slice(match.index + match[0].length,matches[index + 1]?.index).trim().replace(/\r?\n\t/g,'\n').replaceAll(' ·\u00a0',' · ');
    if (!match[1].includes('·')) result.rows.push([]);
    result.rows.at(-1)!.push([label,value]);
  }
  return result;
}

function GoodsInfo({value,image}:{value:string;image?:string}){
  const lines=value.replace(/(资料编码|商品编码)[：:]\s*\r?\n\s*/g,'$1：').split('\n');
  return <div className="ds-goods-detail-cell">
    {image&&<AfterSalesProductImage detail src={image}/>}
    <span className="ds-goods-detail-text" title={value}>{lines.map((line,index)=><span key={index}>{line}{index<lines.length-1?'\n':''}</span>)}</span>
  </div>;
}

function DetailTable({label, rows, columns, hideHeadings = false, images, goods, imageHeading}: {
  label:string; rows:Entry[][]; columns?:readonly string[]; hideHeadings?:boolean; images?:string[]; goods?:boolean; imageHeading?:string;
}) {
  const headers = columns ?? [...new Set(rows.flatMap(row=>row.map(([name])=>name)))];
  return <div className="ds-source-table-scroll">
    <table className="ds-source-table" aria-label={label}>
      <thead className={hideHeadings?'ds-source-hidden-head':undefined}>
        <tr>{imageHeading&&<th className="ds-detail-image-cell" scope="col">{imageHeading}</th>}{headers.map(header=><th key={header} scope="col">{header}</th>)}</tr>
      </thead>
      <tbody>{rows.map((row,index)=><tr key={index} data-total={/^(总计|合计)$/.test(row[0]?.[1]??'')||undefined}>{imageHeading&&<td className="ds-detail-image-cell">{images?.[index]&&<AfterSalesProductImage src={images[index]} detail/>}</td>}{headers.map(header=>{
        const value=row.find(([name])=>name===header)?.[1] || '—';
        return <td key={header}>{goods&&header==='商品信息'&&!/^(总计|合计)$/.test(value)?<GoodsInfo value={value} image={images?.[index]}/>:value}</td>;
      })}</tr>)}</tbody>
    </table>
  </div>;
}

export function DesktopAfterSalesDetailTable({label, content, images, imageHeading}: {label:string; content:string; images?:string[]; imageHeading?:string}) {
  if(content.startsWith('{')){
    try{
      const table:unknown=JSON.parse(content);
      if(table&&typeof table==='object'&&'columns' in table&&'rows' in table&&
         Array.isArray(table.columns)&&table.columns.every(column=>typeof column==='string')&&Array.isArray(table.rows)){
        const columns=table.columns as string[];
        const rows=table.rows.filter((row):row is string[]=>Array.isArray(row)&&row.length===columns.length&&row.every(value=>typeof value==='string'));
        if(rows.length)return <DetailTable label={label} columns={columns} images={images} imageHeading={images?.some(Boolean)?imageHeading:undefined} rows={rows.map(row=>row.map((value,index)=>[columns[index],value]))}/>;
      }
    }catch{/* Older archives use labelled text. */}
  }
  const {rows, notes} = parseRows(content, GOODS_HEADERS,true);
  return <>
    {rows.length > 0 && <DetailTable label={label} rows={rows}/>}
    {notes.length > 0 && <div className="ds-source-notes">{notes.join('\n')}</div>}
  </>;
}

export function DesktopAfterSalesSourcePanel({kind, snapshot, showHeading=true, provider, images}: {
  kind: SourcePanelKind;
  snapshot: DesktopSaleSnapshot;
  showHeading?: boolean;
  provider?:{active:boolean;onSystem:()=>void;onQuery:()=>void;status?:string;error?:boolean;url?:string};
  images?:string[];
}) {
  const panel = SOURCE_PANELS[kind];
  const content = snapshot.fields[panel.field];
  const tracking=kind==='tracking'||kind==='shipping';
  const waybill=tracking?content?.match(/^快递单号：([^\n]+)\n/)?.[1]:undefined;
  const {rows, notes} = parseRows(waybill?content!.replace(/^快递单号：[^\n]+\n/,''):content || '', panel.headers,kind==='goods'||kind==='logs'||tracking);
  const pairs = rows.flat();
  const grouped = kind === 'refund' || kind === 'platform';
  const compactDetails = grouped && pairs.every(([label],index)=>pairs.findIndex(([key])=>key===label)===index);
  let columns: readonly string[] | undefined;
  if (kind==='refund') {
    const amounts=new Map(pairs.map(([label,value])=>[REFUND_ALIASES[label]??label,value]));
    pairs.splice(0,pairs.length,...REFUND_COLUMNS.map(label=>[label,amounts.get(label)??''] as Entry));
  } else if (kind==='logs') {
    columns=LOG_COLUMNS;
    for (const row of rows) for (const entry of row) if (entry[0]==='操作时间') entry[0]='时间';
  } else if(tracking){
    columns=['时间','状态','物流描述'];
    for(const row of rows)for(const entry of row){
      if(['物流时间','更新时间'].includes(entry[0]))entry[0]='时间';
      if(entry[0]==='物流状态')entry[0]='状态';
      if(['详情','物流信息','物流详情','描述','内容','物流轨迹'].includes(entry[0]))entry[0]='物流描述';
    }
  } else if (kind==='goods') {
    columns=GOODS_COLUMNS;
    for (const row of rows) {
      if (!row.some(([label])=>label==='商品信息')) {
        const name=row.find(([label])=>label==='商品名称');
        if (name) name[0]='商品信息';
      }
    }
  }
  return <section className={showHeading?'ds-source-native':'ds-source-native ds-source-native-flat'} aria-label={panel.field}>
    {showHeading&&<h4>{panel.title}</h4>}
    {tracking&&<div className="ds-tracking-summary"><div className="ds-tracking-tabs">
      {provider?<><button type="button" aria-pressed={!provider.active} onClick={provider.onSystem}>系统查询</button>
      <button type="button" aria-pressed={provider.active} onClick={provider.onQuery}>快递100查询</button></>:<span>系统查询</span>}</div><h4>查询结果</h4>{waybill&&<p>{waybill}</p>}</div>}
    {kind==='platform'&&pairs.length===1&&pairs[0][0]==='店铺'
      ? <div className="ds-platform-reminder"><p>当前售后单所在店铺是： <span>{pairs[0][1]}</span></p><p>请确保该店铺为登录状态，否则无法正常查看平台售后单详情</p></div>
      : <>
    {rows.length > 0 && (kind==='refund'
      ? <dl className="ds-refund-formula">{pairs.map(([label,value],index)=><div key={label}>
        {index>0&&<span className="ds-refund-operator" aria-hidden="true">{index===6?'=':index<3?'+':'−'}</span>}
        <div><dt>{label}</dt><dd>{value || '—'}</dd></div>
      </div>)}</dl>
      : compactDetails
      ? <dl className="ds-source-pairs">{pairs.map(([label,value])=><div key={label}>
        <dt>{label}</dt><dd>{value || '—'}</dd>
      </div>)}</dl>
      : <DetailTable label={panel.title} rows={rows} columns={columns} goods={kind==='goods'} images={images} hideHeadings={tracking}/>)}
    {notes.length > 0 && <div className="ds-source-notes">{notes.join('\n')}</div>}
    {provider?.active&&provider.url&&<iframe title="快递100物流查询" className="ds-provider-frame"
      src={provider.url} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer"/>}
    {!content&&!provider?.url&&(provider?.active?
      <p className="ds-source-empty" role={provider.error?'alert':'status'}>{provider.status}</p>:
      <p className="ds-source-empty">暂无已归档明细</p>)}
    </>}
  </section>;
}

export function DesktopAfterSalesLogistics({kind,snapshot,queryProvider}:{
  kind:'tracking'|'shipping';snapshot:DesktopSaleSnapshot;
  queryProvider?:()=>Promise<DesktopSourcePanelSnapshot|null>;
}) {
  const [active,setActive]=useState(false);
  const [result,setResult]=useState<{loading?:boolean;content?:string;status?:string;error?:boolean;url?:string}|null>(null);
  const field=SOURCE_PANELS[kind].field;
  const query=async()=>{
    setActive(true);
    if(!queryProvider||result?.loading||result?.content||result?.url)return;
    setResult({loading:true,status:'正在查询快递100…'});
    try{
      const incoming=await queryProvider();
      if(incoming&&(incoming.afterSaleId!==snapshot.afterSaleId||incoming.sourceCompany!==snapshot.sourceCompany||
        (snapshot.internalOrderId&&incoming.internalOrderId!==snapshot.internalOrderId))){
        throw new Error('快递100结果与当前售后不一致');
      }
      if(incoming&&!incoming.providerUrl&&incoming.provider!=='kuaidi100')throw new Error('请使用新版 OA 客户端查询快递100');
      if(incoming?.providerUrl){
        const url=new URL(incoming.providerUrl);
        if(url.origin!=='https://m.kuaidi100.com'||url.username||url.password)throw new Error('快递100查询地址不受支持');
        setResult({url:url.href});
      }else{
        const content=incoming?.fields[field];
        setResult(content?{content}:{status:'快递100未返回物流轨迹'});
      }
    }catch(error){
      setResult({status:String((error as Error).message||error).replace(/^Error invoking remote method .*?Error: /,''),error:true});
    }
  };
  const displayed=active?{...snapshot,fields:{...snapshot.fields,[field]:result?.content}}:snapshot;
  return <DesktopAfterSalesSourcePanel kind={kind} snapshot={displayed} showHeading={false}
    provider={queryProvider?{active,onSystem:()=>setActive(false),onQuery:()=>void query(),status:result?.status,error:result?.error,url:active?result?.url:undefined}:undefined}/>;
}
