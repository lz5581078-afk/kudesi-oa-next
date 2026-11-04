'use strict';
// Runs in each permitted frame, without Node, cookies, storage or network access.
function extractVisible() {
  const labels = ['订单时间','申请时间','线上类型','商品信息','线上状态','售后单状态','货物状态','原订单下单金额','线上申请金额','实退金额','售后标签','原订单标签','售后分类','退货快递单号','快递拦截状态','拦截失败原因','快递拦截时间','收货仓','仓库','线上订单号','线上售后单号','售后问题类型','售后问题登记','店铺','买家留言','卖家备注','支付金额','售后日志','订单操作日志','订单状态','买家账号','下单时间','发货时间','支付时间','支付方式','收货人','手机号','收货地址','快递公司','快递单号','物流状态','商品明细','商品总数量','商品总成交金额','优惠抵扣金额','运费','应付总金额','实际已付'];
  const clean = v => String(v || '').replace(/[\u0000-\u0008]/g,'').trim().slice(0,12000);
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const rows = [];
  for (const table of document.querySelectorAll('table')) {
    if (!visible(table)) continue;
    let headers = [...table.querySelectorAll('thead th, thead td')].map(x => clean(x.innerText).split('\n')[0]);
    if(!headers.includes('内部订单号')){
      let parent=table.parentElement;
      for(let depth=0;parent&&depth<5;depth++,parent=parent.parentElement){
        const candidates=[...parent.querySelectorAll('thead')].map(head=>[...head.querySelectorAll('th,td')].map(x=>clean(x.innerText).split('\n')[0]));
        const found=candidates.find(h=>h.includes('内部订单号'));if(found){headers=found;break;}
      }
    }
    if (!headers.includes('内部订单号')) continue;
    for (const tr of table.querySelectorAll('tbody tr')) {
      if (!visible(tr)) continue;
      const cells = [...tr.children].filter(x => ['TD','TH'].includes(x.tagName));
      if (cells.length !== headers.length) continue;
      const values = Object.fromEntries(headers.map((h,i) => [h, clean(cells[i].innerText)]));
      const id = values['售后单号']?.match(/\d{4,40}/)?.[0];
      if (!id) continue;
      rows.push({ afterSaleId: id, internalOrderId: values['内部订单号']?.match(/\d{4,40}/)?.[0] || '', fields: Object.fromEntries(labels.filter(k => values[k]).map(k => [k,values[k]])) });
    }
  }
  // The original OrderEditor detail opens in a nested frame. Read labelled sections only.
  const detail = [];
  if (/OrderEditor/i.test(location.pathname)) {
    const text = String(document.body?.innerText || '').slice(0,500000);
    const internalOrderId = text.match(/(?:内部订单号|订单编号)\s*[:：]?\s*(\d{4,40})/)?.[1] || '';
    const matches = [...text.matchAll(/售后单号\s*[:：]?\s*(\d{4,40})/g)];
    for (let i=0;i<matches.length;i++) {
      const match=matches[i];
      const logsAt=text.indexOf('订单操作进程及日志',match.index);
      const section=text.slice(match.index,matches[i+1]?.index ?? (logsAt<0?text.length:logsAt));
      const fields = {};
      const saleFields=new Set(['申请时间','线上类型','线上状态','售后单状态','货物状态','线上申请金额','实退金额','售后标签','售后分类','退货快递单号','收货仓','线上售后单号','售后问题类型','售后问题登记']);
      const aliases={'线上申请金额':'申请金额','申请时间':'申请日期','退货快递单号':'退回快递单号'};
      for (const k of labels.filter(k => !['商品信息','售后日志','订单操作日志'].includes(k))) {
        const found = (saleFields.has(k)?section:text).match(new RegExp('(?:'+k+(aliases[k]?'|'+aliases[k]:'')+')[：:]?\\s*([^\\n]{1,1000})'));
        if (found) fields[k] = clean(found[1]);
      }
      // Read displayed business form values as well as text labels; never passwords/hidden controls.
      for(const k of ['收货人','手机号','收货地址','买家留言','卖家备注']){
        const label=[...document.querySelectorAll('label,td,th,span')].find(el=>visible(el)&&el.children.length===0&&clean(el.innerText).replace(/[：:]$/,'')===k);
        if(!label)continue;
        let scope=label.closest('td,th')||label.parentElement;
        const readControls=el=>[...(el?.querySelectorAll('input,textarea,select')??[])].filter(c=>visible(c)&&!['password','hidden','checkbox','radio','button','submit'].includes(c.type));
        let controls=readControls(scope);if(!controls.length&&scope?.nextElementSibling)controls=readControls(scope.nextElementSibling);
        const values=controls.map(c=>c.tagName==='SELECT'?[...c.selectedOptions].map(o=>o.textContent).join(' '):c.value).filter(Boolean);
        if(values.length)fields[k]=clean(values.join(' '));
      }
      const goods=[];
      for(const table of document.querySelectorAll('table')){
        if(!visible(table))continue;
        let heads=[...table.querySelectorAll('thead th,thead td')].map(x=>clean(x.innerText).split('\n')[0]);
        if(!heads.length)heads=[...(table.querySelector('tr')?.children??[])].map(x=>clean(x.innerText).split('\n')[0]);
        if(!heads.some(h=>/^(商品信息|商品名称|商品编码|款编码)$/.test(h))||heads.includes('内部订单号'))continue;
        const permitted=heads.map((h,index)=>({h,index})).filter(({h})=>/^(商品信息|商品名称|商品编码|款编码|颜色|规格|数量|单价|金额|商品金额|实付金额|售价|退货数量)$/.test(h));
        for(const tr of table.querySelectorAll('tbody tr')){if(!visible(tr))continue;const cells=[...tr.children];if(cells.length!==heads.length||cells.every((c,index)=>clean(c.innerText)===heads[index]))continue;goods.push(permitted.map(({h,index})=>h+'：'+clean(cells[index].innerText)).join(' · '));}
      }
      if(goods.length)fields['商品明细']=clean(goods.join('\n'));
      const logs = text.split(/订单操作进程及日志/)[1];
      if (logs) fields['订单操作日志'] = clean(logs);
      detail.push({afterSaleId:match[1],internalOrderId,fields});
    }
  }
  const text = document.body?.innerText || '';
  const sourceCompany = clean(text.match(/([^\n]{1,80})\s*\[[^\]]+\]/)?.[1] || '');
  return { rows, detail, sourceCompany };
}
function mergeFrames(frames) {
  const rows = new Map();
  const company = frames.map(f=>f.sourceCompany).find(Boolean) || '';
  for (const f of frames) for (const r of f.rows) rows.set(r.afterSaleId,{...r,sourceCompany:company,capturedAt:new Date().toISOString()});
  for (const f of frames) for (const d of f.detail) {
    const r = rows.get(d.afterSaleId);
    if (r && r.internalOrderId && d.internalOrderId && r.internalOrderId !== d.internalOrderId) continue;
    rows.set(d.afterSaleId,{...r,...d,internalOrderId:d.internalOrderId || r?.internalOrderId || '',fields:{...r?.fields,...d.fields},sourceCompany:company,capturedAt:new Date().toISOString()});
  }
  return [...rows.values()];
}
function openVisibleOrder(id) {
  for (const table of document.querySelectorAll('table')) {
    let heads=[...table.querySelectorAll('thead th,thead td')].map(e=>e.innerText.trim().split('\n')[0]);
    if(!heads.includes('内部订单号')){let parent=table.parentElement;for(let depth=0;parent&&depth<5;depth++,parent=parent.parentElement){const candidate=[...parent.querySelectorAll('thead')].map(h=>[...h.querySelectorAll('th,td')].map(e=>e.innerText.trim().split('\n')[0])).find(h=>h.includes('内部订单号'));if(candidate){heads=candidate;break;}}}
    const index=heads.indexOf('内部订单号');if(index<0)continue;
    for(const row of table.querySelectorAll('tbody tr')){
      const cell=row.children[index];if(!cell)continue;
      const link=[...cell.querySelectorAll('a,button,[role="button"]')].find(e=>e.textContent.trim()===id&&e.getClientRects().length);
      if(link){link.click();return true;}
    }
  }
  return false;
}
module.exports = { extractVisible, mergeFrames, openVisibleOrder };
