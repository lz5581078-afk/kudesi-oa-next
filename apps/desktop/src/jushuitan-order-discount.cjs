'use strict';

// The order frame and both order identifiers are verified before this function runs.
async function readJushuitanOrderDiscount() {
  const payment=document.getElementById('revenue_statistics');
  const trigger=document.getElementById('show_revenue_statistics_item');
  const visible=element=>!!element?.getClientRects().length&&getComputedStyle(element).visibility!=='hidden'&&!element.closest('[hidden]');
  const read=element=>visible(element)?String(element.innerText??'').trim():'';
  if(!visible(payment)||!visible(trigger)||read(trigger)!=='查看优惠明细')return null;
  const amount=/^[+-]?(?:[¥￥]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*元)?$/;
  const label=/^[\u4e00-\u9fff（）()\s]{2,24}$/;
  const relevant=/优惠|补贴|折扣|优惠券|红包|立减|买家实付|线上原始金额/;
  const nodes='[role="dialog"],[role="tooltip"],.ant-modal,.ant-popover,.ant-tooltip,.ui-dialog,._dialog_panel,[id*="revenue_statistics_item"]';
  const previous=new Set([...document.querySelectorAll(nodes)].filter(visible));
  const result=(root,summary)=>{
    if(!summary){
      for(const table of root.querySelectorAll('table')){
        const header=table.tHead?.rows[0]??table.rows[0];
        const headings=[...(header?.cells??[])].map(cell=>read(cell).replace(/\s+/g,''));
        const project=headings.findIndex(value=>/^(优惠类型|优惠项目|优惠名称|优惠券名称|活动名称|项目|名称)$/.test(value));
        const total=headings.findIndex(value=>/^(?:优惠|折扣|分摊|补贴)?金额(?:[（(]元[）)])?$/.test(value));
        if(project<0||total<0)continue;
        const items=[...table.rows].filter(row=>row!==header&&visible(row)).flatMap(row=>{
          const name=read(row.cells[project]),value=read(row.cells[total]);
          return name&&name.length<=100&&!/https?:|password|token|cookie|authorization/i.test(name)&&amount.test(value)?[[name,value]]:[];
        });
        if(items.length)return {summary:false,items:items.slice(0,40)};
      }
    }
    const items=[];
    for(const cell of root.querySelectorAll('td,th,dd,li,[data-label]')){
      if(!visible(cell))continue;
      const inline=read(cell).replace(/\s+/g,' ').match(/^([\u4e00-\u9fff（）()\s]{2,24})\s*[:：]?\s*([+-]?(?:[¥￥]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*元)?)$/);
      if(inline&&relevant.test(inline[1])){items.push([inline[1].trim(),inline[2]]);continue;}
      if(cell.localName==='td'&&relevant.test(read(cell))&&label.test(read(cell))&&amount.test(read(cell.nextElementSibling))){
        items.push([read(cell),read(cell.nextElementSibling)]);
      }
    }
    return {summary,items:items.slice(0,40)};
  };
  trigger.scrollIntoView?.({block:'nearest'});
  trigger.click();
  const deadline=Date.now()+1200;
  while(Date.now()<deadline){
    for(const panel of document.querySelectorAll(nodes)){
      if(!visible(panel)||previous.has(panel)||panel.contains(payment)||payment.contains(panel)||
         !/优惠明细|优惠金额|优惠类型|折扣|补贴/.test(read(panel)))continue;
      const details=result(panel,false);
      if(details.items.length)return details;
    }
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  return result(payment,true);
}

module.exports={readJushuitanOrderDiscount};
