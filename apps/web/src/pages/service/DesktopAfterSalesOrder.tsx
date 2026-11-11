import { useState } from 'react';
import { DesktopAfterSalesPopup } from './DesktopAfterSalesPopup';
import { formatAfterSalesField, type AfterSalesField, type DesktopSaleSnapshot } from '@kudesi/shared';
import { DesktopAfterSalesDetailTable, DesktopAfterSalesSourcePanel, SOURCE_PANELS } from './DesktopAfterSalesSourcePanel';
import type { DesktopSourcePanel } from './desktopBridge';

type Field = readonly [label: string, key: AfterSalesField];
const SALE_INFO: readonly Field[] = [
  ['状态','售后单状态'], ['货物状态','货物状态'], ['线上类型','线上类型'], ['售后分类','售后分类'],
  ['线上状态','线上状态'], ['问题类型','售后问题类型'], ['快递登记','快递登记'], ['仓库','仓库'], ['登记时间','登记时间'],
  ['售后异常','售后异常'], ['备注','备注'], ['退货快递单号','退货快递单号'],
  ['买家退款账号','买家退款账号'], ['卖家退款账号','卖家退款账号'],
];
const SALE_AMOUNTS: readonly Field[] = [
  ['线上金额','售后线上金额说明'], ['线上申请总金额','线上申请金额'], ['线上商品应退金额','线上商品应退金额'], ['线上退运费','线上退运费'],
  ['商品应退金额','商品应退金额'], ['应退运费','卖家应退运费'], ['优惠/差额','优惠/差额'], ['卖家应补','卖家应补'],
  ['换货金额','换货金额'], ['买家应补','买家应补'], ['实退金额','实退金额'],
];
const SOURCE_ORDER: readonly Field[] = [
  ['店铺','店铺'], ['线上单号','线上订单号'], ['买家帐号','买家账号'], ['收货人','单据收货人'],
];
const TRADE: readonly Field[] = [
  ['线上单号','线上订单号'], ['付款时间','付款时间'], ['订单时间','订单时间'], ['店铺','店铺'],
  ['订单来源','订单来源'], ['买家帐号','买家账号'], ['订单状态','订单状态'],
];
const SHIPPING: readonly Field[] = [
  ['快递公司','快递公司'], ['快递单号','快递单号'], ['买家已付运费','买家已付运费'],
  ['订单包材','订单包材'], ['发货时间','发货时间'], ['物流状态','物流状态'],
];
const REMARKS: readonly Field[] = [['买家留言','买家留言'], ['卖家备注','卖家备注']];
const ADDRESS: readonly Field[] = [['收货地址','收货地址'], ['收货人','单据收货人'], ['手机号','手机号']];
const PAYMENT: readonly Field[] = [
  ['金额','订单支付金额'], ['支付日期','订单支付日期'], ['线上原始金额','线上原始金额'],
  ['买家实付','实际已付'], ['支付优惠','支付优惠'], ['店铺优惠','店铺优惠'], ['支付方式','支付方式'],
];
const ORDER_AMOUNTS: readonly Field[] = [
  ['商品总数量','商品总数量'], ['商品总成交金额','商品总成交金额'], ['优惠抵扣金额','优惠抵扣金额'],
  ['运费','运费'], ['应付总金额','应付总金额'],
];
const ORDER_SALE: readonly Field[] = [
  ['售后分类','售后分类'], ['售后单状态','售后单状态'], ['申请金额','线上申请金额'], ['申请日期','申请时间'],
];

export const INTERNAL_ORDER_FIELDS: readonly AfterSalesField[] = [
  ...[TRADE, SHIPPING, REMARKS, ADDRESS, PAYMENT, ORDER_AMOUNTS].flatMap(group=>group.map(([,key])=>key)),
  '下单时间','支付时间','商品明细','订单操作日志',
];

function DetailsGroup({title, fields, snapshot, children, action}:{
  title:string; fields:readonly Field[]; snapshot:DesktopSaleSnapshot; children?:React.ReactNode; action?:React.ReactNode;
}) {
  return <section className="ds-document-group" aria-label={title}>
    <h4>{title}{action}</h4>
    <dl className="ds-document-pairs">{children}{fields.map(([label,key])=><div key={key}>
      <dt>{label}</dt><dd>{formatAfterSalesField(key,snapshot.fields[key]??(key==='单据收货人'?snapshot.fields['收货人']:'')??'')||'—'}</dd>
    </div>)}</dl>
  </section>;
}

function DetailSection({title, children}:{title:string;children:React.ReactNode}) {
  return <section className="ds-document-group" aria-label={title}><h4>{title}</h4>{children}</section>;
}

function parseDiscount(content?:string):{summary:boolean;items:[string,string][]}|null {
  if(!content)return null;
  try{
    const parsed=JSON.parse(content);
    if(typeof parsed?.summary!=='boolean'||!Array.isArray(parsed.items))return null;
    const items=parsed.items.filter((item:unknown):item is [string,string]=>
      Array.isArray(item)&&item.length===2&&item.every(value=>typeof value==='string'));
    return {summary:parsed.summary,items};
  }catch{return null;}
}

export function DesktopAfterSalesOrder({snapshot,onOpenSale,images,onReadDiscount}: {
  snapshot:DesktopSaleSnapshot;onOpenSale?:()=>void;images?:string[];onReadDiscount?:()=>Promise<void>;
}) {
  const [discountOpen,setDiscountOpen]=useState(false);
  const [discountStatus,setDiscountStatus]=useState<{text:string;error?:boolean}|null>(null);
  const fields=snapshot.fields;
  const discount=parseDiscount(fields['订单优惠明细']);
  const archivedItems=PAYMENT.filter(([label,key])=>/优惠|补贴|实付|原始金额/.test(label)&&fields[key]).map(([label,key])=>[label,fields[key]!] as const);
  const discountItems=discount?.items.length?discount.items:archivedItems;
  const canViewDiscount=!!fields['订单优惠明细']||archivedItems.length>0||!!fields['订单支付金额'];
  const openDiscount=()=>{
    setDiscountOpen(true);
    if(!onReadDiscount)return;
    setDiscountStatus({text:'正在核对聚水潭优惠明细…'});
    void onReadDiscount().then(()=>setDiscountStatus(null)).catch(error=>setDiscountStatus({
      text:String((error as Error).message||error).replace(/^Error invoking remote method .*?Error: /,''),error:true,
    }));
  };
  return <article className="ds-source-document" aria-label="内部订单详情">
    <div className="ds-document-grid">
      <DetailsGroup title="交易信息" fields={TRADE} snapshot={snapshot}>
        <div><dt>订单编号</dt><dd>{snapshot.internalOrderId||'—'}</dd></div>
      </DetailsGroup>
      <DetailsGroup title="物流信息" fields={SHIPPING} snapshot={snapshot}/>
      <DetailsGroup title="备注信息" fields={REMARKS} snapshot={snapshot}/>
      <DetailsGroup title="收货地址信息" fields={ADDRESS} snapshot={snapshot}/>
    </div>
    <DetailsGroup title="订单支付情况" fields={PAYMENT} snapshot={snapshot}
      action={canViewDiscount&&<button type="button" className="ds-link ds-discount-link" onClick={openDiscount}>查看优惠明细</button>}/>
    {discountOpen&&<DesktopAfterSalesPopup title="订单优惠明细" onClose={()=>setDiscountOpen(false)}>
      {discountStatus&&<p role={discountStatus.error?'alert':'status'}>{discountStatus.text}</p>}
      {discountItems.length>0&&<>
        {(!discount||discount.summary)&&<p className="ds-document-status">聚水潭支付区金额汇总</p>}
        <table className="ds-source-table" aria-label="订单优惠金额">
          <thead><tr><th scope="col">项目</th><th scope="col">金额</th></tr></thead>
          <tbody>{discountItems.map(([label,value],index)=><tr key={index}><td>{label}</td><td>{value}</td></tr>)}</tbody>
        </table>
      </>}
      {discount?.summary&&<p className="ds-document-status">聚水潭本次未返回逐笔优惠记录。</p>}
      {!discountItems.length&&!discountStatus&&<p className="ds-source-empty">暂无优惠记录</p>}
    </DesktopAfterSalesPopup>}
    <DetailSection title="订单商品">
      {fields['商品明细']?<DesktopAfterSalesDetailTable label="商品明细" content={fields['商品明细']} images={images} imageHeading="图片"/>:<p className="ds-source-empty">暂无已归档的订单商品</p>}
      <dl className="ds-document-totals">{ORDER_AMOUNTS.filter(([,key])=>fields[key]).map(([label,key])=><div key={key}><dt>{label}</dt><dd>{fields[key]}</dd></div>)}</dl>
    </DetailSection>
    <DetailsGroup title="售后信息" fields={ORDER_SALE} snapshot={snapshot}>
      <div><dt>售后单号</dt><dd>{onOpenSale?<button type="button" className="ds-link" onClick={onOpenSale}>{snapshot.afterSaleId}</button>:snapshot.afterSaleId}</dd></div>
    </DetailsGroup>
    <DetailSection title="订单操作进程及日志">
      <p className="ds-source-notes">{fields['订单操作日志']||'暂无已归档的订单日志'}</p>
    </DetailSection>
  </article>;
}

export function DesktopAfterSalesSale({snapshot,onOpenOrder,onShowPanel,images}:{
  snapshot:DesktopSaleSnapshot; onOpenOrder:()=>void; onShowPanel:(panel:DesktopSourcePanel)=>void; images?:string[];
}) {
  const fields=snapshot.fields;
  return <article className="ds-source-document" aria-label="售后单详情">
    <div className="ds-document-grid">
      <DetailsGroup title="售后单信息" fields={SALE_INFO} snapshot={snapshot}>
        <div><dt>售后单号</dt><dd>{snapshot.afterSaleId}</dd></div>
      </DetailsGroup>
      <DetailsGroup title="售后单金额" fields={SALE_AMOUNTS} snapshot={snapshot}/>
    </div>
    <DetailsGroup title="原订单信息" fields={SOURCE_ORDER} snapshot={snapshot}>
      <div><dt>内部订单号</dt><dd>{snapshot.internalOrderId?
        <button type="button" className="ds-link" onClick={onOpenOrder}>{snapshot.internalOrderId}</button>:<button type="button" className="ds-link" disabled>待聚水潭补齐</button>}</dd></div>
    </DetailsGroup>
    <DetailSection title="售后商品信息">
      {fields['售后详情商品明细']?<DesktopAfterSalesDetailTable label="售后商品信息" content={fields['售后详情商品明细']} images={images} imageHeading="图"/>
        :fields['售后商品明细']?<DesktopAfterSalesSourcePanel kind="goods" snapshot={snapshot} showHeading={false}/>
        :<p className="ds-source-empty">{fields['商品信息']||'暂无已归档的售后商品'}</p>}
      {fields['售后详情商品汇总']&&<p className="ds-source-notes">{fields['售后详情商品汇总']}</p>}
      <div className="ds-document-links">
        {(['goods','refund','tracking','shipping','platform'] as const).map(kind=><button type="button" key={kind} className="ds-link" onClick={()=>onShowPanel(kind)}>{SOURCE_PANELS[kind].label}</button>)}
      </div>
    </DetailSection>
    <DetailSection title="操作进程及日志">
      {fields['售后详情操作日志']?<p className="ds-source-notes">{fields['售后详情操作日志']}</p>:
        fields['售后日志']?<DesktopAfterSalesSourcePanel kind="logs" snapshot={snapshot} showHeading={false}/>:null}
      <div className="ds-document-links"><button type="button" className="ds-link" onClick={()=>onShowPanel('logs')}>查看日志</button></div>
    </DetailSection>
  </article>;
}
