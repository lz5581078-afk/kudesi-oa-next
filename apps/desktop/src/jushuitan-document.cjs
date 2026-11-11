'use strict';

// Serialized into the exact source detail frame. Only rendered, allowlisted values are returned.
function readJushuitanDocument(identity, kind, readImage) {
  const sale=kind==='sale';
  const sourcePath=sale?/\/app\/Service\/aftersale\/editor\.aspx$/i:/\/app\/order\/order\/OrderEditor(?:New)?\.aspx$/i;
  if(!sourcePath.test(location.pathname))return null;
  const clean=value=>String(value??'').replace(/[\u0000-\u0008]/g,'').trim()
    .replace(/https?:\/\/[^\s"<>]+/gi,'[链接已移除]')
    .replace(/(?:jmxToken|access_token|authorization|password|cookie)\s*[:=]\s*[^\n]+/gi,'[凭据已移除]');
  const visible=el=>!!el?.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.closest('[hidden]');
  const text=el=>visible(el)?clean(el.innerText):'';
  const sourceOrder=text(document.getElementById('o_id'));
  const sourceSale=text(document.getElementById('as_id'));
  if(!/^\d{4,40}$/.test(sourceOrder)||(identity.internalOrderId&&sourceOrder!==identity.internalOrderId)||
     (sale&&sourceSale!==identity.afterSaleId))return null;
  const fieldNames=sale?{
    '状态':'售后单状态','货物状态':'货物状态','线上类型':'线上类型','售后分类':'售后分类',
    '问题类型':'售后问题类型','快递登记':'快递登记','买家退款账号':'买家退款账号','卖家退款账号':'卖家退款账号',
    '仓库':'仓库','登记时间':'登记时间','售后异常':'售后异常','备注':'备注','线上金额':'售后线上金额说明','线上申请总金额':'线上申请金额',
    '线上商品应退金额':'线上商品应退金额','线上退运费':'线上退运费','商品应退金额':'商品应退金额',
    '应退运费':'卖家应退运费','优惠/差额':'优惠/差额','卖家应补':'卖家应补','换货金额':'换货金额',
    '买家应补':'买家应补','实退金额':'实退金额','店铺':'店铺','线上单号':'线上订单号',
    '买家帐号':'买家账号','收货人':'单据收货人','退货快递单号':'退货快递单号',
  }:{
    '线上单号':'线上订单号','付款时间':'付款时间','订单时间':'订单时间','下单时间':'下单时间',
    '店铺':'店铺','订单来源':'订单来源','买家帐号':'买家账号','买家留言':'买家留言','订单状态':'订单状态',
    '快递公司':'快递公司','快递单号':'快递单号','买家已付运费':'买家已付运费','订单包材':'订单包材',
    '发货时间':'发货时间','物流状态':'物流状态','卖家备注':'卖家备注','收货地址':'收货地址',
    '收货人':'单据收货人','手机号':'手机号','手机':'手机号','金额':'订单支付金额','支付日期':'订单支付日期',
    '线上原始金额':'线上原始金额','买家实付':'实际已付','支付优惠':'支付优惠','店铺优惠':'店铺优惠',
    '支付方式':'支付方式','商品总数量':'商品总数量','商品总成交金额':'商品总成交金额',
    '优惠抵扣金额':'优惠抵扣金额','运费':'运费','应付总金额':'应付总金额',
  };
  const totals=new Set(['申请退货总数量','明细买家实付','明细商家实收','实收总数量','退货总金额']);
  const displayControl='select,textarea,input:not([type]),input[type="text"],input[type="tel"],input[type="number"]';
  const readValue=element=>{
    if(!visible(element)||element.matches('button,[role="button"],a.btn_blue,[class*="decrypt" i]'))return '';
    if(element.matches('select'))return clean([...element.selectedOptions].map(option=>option.textContent).join(' '));
    if(element.matches(displayControl))return clean(element.value);
    if(element.matches('input'))return '';
    const controls=[...element.querySelectorAll(displayControl)].filter(visible);
    return controls.length?controls.map(readValue).filter(Boolean).join(' '):text(element);
  };
  const fields={}, summary=[];
  for(const label of document.querySelectorAll('.head_text')){
    const name=text(label).replace(/[:：]$/,'').trim();
    if(!Object.hasOwn(fieldNames,name)&&!(sale&&totals.has(name)))continue;
    const values=[];
    for(let next=label.nextElementSibling;next&&!next.matches('.head_text,br');next=next.nextElementSibling){
      const value=readValue(next);
      if(value)values.push(value);
      if(values.length&&name!=='收货地址')break;
    }
    const value=values.join(' ').slice(0,1000);
    if(!value)continue;
    if(sale&&totals.has(name))summary.push(name+'：'+value);
    else if(!(fieldNames[name] in fields))fields[fieldNames[name]]=value;
  }
  if(summary.length)fields['售后详情商品汇总']=summary.join('\n');

  const table=document.getElementById('item_list');
  const header=table?.tHead?.rows[0]??table?.rows[0];
  if(!visible(table)||!visible(header))return null;
  const cellSlots=row=>[...row.cells].filter(visible).flatMap(cell=>Array(cell.colSpan).fill(cell));
  const headerSlots=cellSlots(header);
  const headers=headerSlots.map(cell=>text(cell).replace(/\s+/g,'').replace(/[（(]回车保存[）)]/g,''));
  const accepted=/^(商品信息|商品名称|名称|商品简称|编码|商品编码|款编码|数量|单价|原价|成本价|原价金额|成交金额(?:买家实付卖家实收)?|优惠金额|买家实付|卖家实收|可配货库存|线上明细金额|申请数量|实退数量|类型|明细问题类型|申请金额|商家实退（含平台补贴）|实际收货金额|退货数量|规格|仓库|备注)$/;
  const columns=headers.flatMap((name,index)=>{
    if(index>0&&headerSlots[index]===headerSlots[index-1])return [];
    if(sale&&/^商家实退[（(]含平台补贴[）)]$/.test(name))name='商家实退（含平台补贴）';
    return accepted.test(name)?[{name:name==='成交金额买家实付卖家实收'?'成交金额 / 买家实付 / 卖家实收':name,index}]:[];
  });
  const imageIndex=headers.findIndex(name=>name==='图片'||name==='图');
  const items=[...table.tBodies].flatMap(body=>[...body.rows]).filter(row=>row!==header&&visible(row))
    .map(cellSlots).filter(cells=>cells.length===headerSlots.length)
    .map(cells=>({values:columns.map(({index})=>readValue(cells[index])),
      image:[...(cells[imageIndex]?.querySelectorAll('img')??[])].filter(visible).map(img=>readImage?.(img)??'').find(Boolean)??''}))
    .filter(item=>item.values.some(Boolean));
  let productImages;
  if(columns.length&&items.length){
    const documentTable=JSON.stringify({columns:columns.map(column=>column.name),rows:items.map(item=>item.values)});
    if(documentTable.length<=12000){
      fields[sale?'售后详情商品明细':'商品明细']=documentTable;
      if(items.some(item=>item.image))productImages=items.map(item=>item.image);
    }
  }
  const logs=document.getElementById('actions');
  const logText=text(logs);
  if(logText)fields[sale?'售后详情操作日志':'订单操作日志']=logText.slice(0,12000);
  return Object.keys(fields).length?{...identity,internalOrderId:sourceOrder,fields,...(productImages?{productImages}:{})}:null;
}

module.exports={readJushuitanDocument};
