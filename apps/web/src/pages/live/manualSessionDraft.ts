import type { LiveChannel } from '@kudesi/shared';
import type { SessionDetail } from './liveApi';
import { initialChannels } from './ChannelPicker';
import { storeDrafts } from './StorePerformanceTable';

/** 原场次是事实记录：销售取主播填报，投流取中控填报；保留秒、订单与逐店核定原因。 */
export function manualSessionDraft(s: SessionDetail, now: string) {
  const channels: LiveChannel[] = s.channels?.length ? s.channels : [{accountId:s.douyinAccount.id,accountName:s.douyinAccount.name,platform:'douyin',storeIds:s.store?[s.store.id]:[],stores:s.store?[{id:s.store.id,name:s.store.name,jstShopId:''}]:[]}];
  const anchor = s.reports.find(r=>r.role==='anchor');
  const control = s.reports.find(r=>r.role==='control');
  const basis = anchor ?? control ?? s.reports.find(r=>r.role==='operator');
  const shops = [...new Map(channels.flatMap(c=>c.stores.map(store=>[store.id,{...store,platform:c.platform}] as const))).values()];
  const lines = basis?.storeLines?.length ? basis.storeLines.map(line=>({...line,adSpendCents:control?.storeLines?.find(row=>row.storeId===line.storeId)?.adSpendCents ?? (shops.length===1 ? control?.adSpendCents : undefined) ?? line.adSpendCents}))
    : basis && shops.length===1 ? [{storeId:shops[0].id,platform:shops[0].platform,salesCents:basis.salesCents,adSpendCents:control?.adSpendCents??basis.adSpendCents??0,reason:s.manualReason||basis.note||'',orderIds:basis.orders.map(order=>order.orderId)}] : [];
  return {
    channels:initialChannels(s), snapshot:channels, rows:storeDrafts(channels,lines),
    fields:{sessionId:String(s.id),roomId:String(s.roomId),anchorId:String(s.anchor.id),controlId:String(s.control?.id??''),operatorId:String(s.operator?.id??''),douyinAccountId:String(s.douyinAccount.id),storeId:String(s.store?.id??''),startAt:s.startAt,endAt:s.endAt??basis?.endAt??now,sales:basis?String(basis.salesCents/100):'',ad:control?.adSpendCents!=null?String(control.adSpendCents/100):'0',controlSales:'',operatorSales:'',reason:s.manualReason||basis?.note||'',orders:basis?.orders.map(order=>order.orderId).join('\n')??''},
  };
}
export function manualApiTime(value: string) {
  const normalized=value.replace('T',' ').replace(/(\d{2}:\d{2}:\d{2})\.\d{1,3}$/, '$1');
  return normalized.length===16?`${normalized}:00`:normalized;
}
