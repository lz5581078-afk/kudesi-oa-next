'use strict';
// Runs in each permitted frame, without Node, cookies, storage or network access.
function extractVisible(order,readRecordingStatus) {
  const labels = ['订单时间','申请时间','线上类型','商品信息','线上状态','售后单状态','货物状态','原订单下单金额','线上申请金额','实退金额','售后标签','原订单标签','售后分类','退货快递单号','快递拦截状态','解决方案','拦截失败原因','快递拦截时间','收货仓','仓库','线上订单号','线上售后单号','售后问题类型','售后问题登记','店铺','买家留言','卖家备注','支付金额','售后日志','订单操作日志','订单状态','买家账号','下单时间','发货时间','支付时间','支付方式','收货人','手机号','收货地址','快递公司','快递单号','物流状态','商品明细','商品总数量','商品总成交金额','优惠抵扣金额','运费','应付总金额','实际已付','供分销备注','聚工单','异常状态','确认时间','原订单状态','订单状态快照','发货快递单号','原订单采购金额','申请退货数量','原订单发货仓库','原订单备注/旗帜','原订单线下备注','原订单业务员','实际收货金额','实退数量','创建人','修改人','平台售后详情','仲裁状态','备注','业务类型','退货签收时间','商家实退','线上商品应退金额','线上退运费','商品应退金额','优惠/差额','卖家应补','卖家应退运费','换货金额','买家应补','买家退款账号','卖家退款账号','退款原因','处理结果','退款状态','售后异常','供销外部处理状态','供销退款状态','分销商','已提交分销商','买家图片凭证','原订单类型','原订单赠品','最后修改日期','登记时间','超时时间','自动化推送状态','原始线上单号','外部交易单号','供应商售后单状态','供应商退款状态','修改时间','付款时间','退货金额','买家应补运费','拒绝原因','平台卖家退货地址','退货物流状态','售后商品明细','实退金额明细','退货物流明细','发货物流明细','平台售后记录','原订单旗帜','售后标签样式','原订单标签样式','售后问题附件','供分销备注附件','原列表可编辑字段'];
  const clean = v => String(v || '').replace(/[\u0000-\u0008]/g,'').trim().slice(0,12000);
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const aliases={'申请日期': '申请时间', '状态': '售后单状态', '买家帐号': '买家账号', '手机': '手机号', '退回快递公司': '快递公司', '退回快递单号(运单号)': '退货快递单号', '商品应退数量': '申请退货数量', '商品实退数量': '实退数量', '线上申请总金额': '线上申请金额', '问题类型': '售后问题类型', '售后问题登记(图片/线下备注)': '售后问题登记', '原订单备注': '原订单备注/旗帜', '原订单买家留言': '买家留言', '订单日期': '订单时间', '订单支付日期': '支付时间', '最后确认日期': '确认时间', '订单发货时间': '发货时间', '标记|多标签': '售后标签', '原订单快递单号': '发货快递单号', '原订单便签｜线下备注': '原订单线下备注'};
  const heading = el => {
    if (!visible(el)) return '';
    const label = clean(el.innerText).split('\n')[0].replace(/^商品信息\s*展示设置.*$/, '商品信息');
    return Object.hasOwn(aliases,label) ? aliases[label] : label;
  };
  const choiceLabels = new Set(['解决方案', '售后分类', '仓库', '售后问题类型', '处理结果']);
  const amountLabels = new Set(['买家应补运费', '卖家应退运费', '卖家应补']);
  const trackingInputTypes = new Set(['text', 'search', 'tel', 'number']);
  const visibleControl = control => visible(control) && !control.closest('[hidden], [aria-hidden="true"]');
  const attributeText = cell => clean([...cell.querySelectorAll('[title],[aria-label],img[alt]')]
    .filter(visible).map(el => el.getAttribute('aria-label') || el.title || el.getAttribute('alt'))
    .filter(Boolean).join(' · '));
  const hexColor = value => {
    const rgb = /^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/.exec(value);
    return rgb && rgb.slice(1).every(part => Number(part) <= 255)
      ? '#' + rgb.slice(1).map(part => Number(part).toString(16).padStart(2,'0')).join('')
      : '';
  };
  const attachmentFields = {'售后问题登记':'售后问题附件','供分销备注':'供分销备注附件'};
  const originalOrderRemark = cell => {
    const note = cell.querySelector('.ellipsis-2-line');
    const flag = [...cell.querySelectorAll('svg use')].find(icon =>
      (icon.getAttribute('href') || icon.getAttribute('xlink:href')) === '#icon-qizhi' &&
      visible(icon.closest('svg')) && !icon.closest('[hidden]'));
    const fields = [['原订单备注/旗帜', note ? clean(note.innerText) : clean(cell.innerText)]];
    if (flag) {
      const color=hexColor(getComputedStyle(flag.closest('svg')).color);
      if(color)fields.push(['原订单旗帜',color]);
    } else if (note) {
      // The current source layout renders the note container even with no note or flag.
      fields.push(['原订单旗帜', '']);
    }
    return fields;
  };
  const cellText = (cell, label) => {
    if(label==='线上订单号'){
      const number=cell.querySelector('[class*="-oneLineBox"] [class*="-name"], .oneLineBox .name');
      if(visibleControl(number))return clean(number.innerText);
    }
    if (choiceLabels.has(label) || label === '退货快递单号') {
      const selects = [...cell.querySelectorAll('select')].filter(visibleControl);
      const choices = selects.flatMap(select => [...select.selectedOptions].map(option => clean(option.label)));
      choices.push(...[...cell.querySelectorAll('.ant-select-selection-item')].filter(visibleControl)
        .map(item => clean(item.title || item.innerText)));
      if (label !== '退货快递单号' && selects.length) return clean(choices.join('\n'));
      if (label === '退货快递单号') {
        const inputs = [...cell.querySelectorAll('input')]
          .filter(input => trackingInputTypes.has(input.type) && visibleControl(input))
          .map(input => clean(input.value));
        const values = [...choices, ...inputs].filter(Boolean);
        const displayed = clean(cell.innerText) || attributeText(cell);
        const text = selects.length ? [] : displayed.split('\n').map(clean).filter(line => line && line !== '查看物流');
        return clean([...new Set([...values, ...text])].join('\n'));
      }
      if (choices.length) return clean(choices.join('\n'));
    }
    if (label === '备注' || amountLabels.has(label)) {
      const controls = [...cell.querySelectorAll('input,textarea')].filter(visibleControl);
      const input = controls.find(control => label === '备注'
        ? control.matches('textarea,input[type="text"],input:not([type])')
        : control.matches('input[type="number"],input[role="spinbutton"]'));
      if (input) return clean(input.value);
    }
    return clean(cell.innerText) || attributeText(cell);
  };
  const readCell = (header,cell) => {
    if(!header||!visible(cell))return [];
    if(header==='原订单备注/旗帜')return originalOrderRemark(cell);
    if(header==='售后标签'||header==='原订单标签'){
      const tags=[...cell.querySelectorAll('[class*="-tagColor"]')].filter(tag=>visibleControl(tag)&&clean(tag.innerText));
      if(tags.length||cell.querySelector('[class*="-tagList"]')){
        const colors=tags.map(tag=>{
          const style=getComputedStyle(tag);
          return hexColor(style.color)+'/'+hexColor(style.backgroundColor);
        });
        return [[header,clean(tags.map(tag=>clean(tag.innerText).replace(/\s+/g,' ')).join('\n'))],[header+'样式',clean(colors.join('\n'))]];
      }
    }
    if(Object.hasOwn(attachmentFields,header)&&cell.matches('td.art-table-cell')){
      const controls=[...cell.querySelectorAll('button')].filter(button=>visibleControl(button)&&!button.disabled&&
        [...button.querySelectorAll('svg use')].some(icon=>(icon.getAttribute('href')||icon.getAttribute('xlink:href'))==='#icon-dingdandaochu3'));
      const downloads=controls.filter(button=>/下载/.test([button.innerText,button.title,button.getAttribute('aria-label')].join(' '))&&
        !/上传/.test([button.innerText,button.title,button.getAttribute('aria-label')].join(' ')));
      const file=downloads.length===1?'下载附件':'';
      const note=cell.querySelector('p.ellipsis-2-line');
      const text=controls.reduce((value,button)=>value.replace(clean(button.innerText),''),cellText(cell,header));
      const noteText=note?clean(note.innerText):clean(text);
      return [[header,noteText],[attachmentFields[header],file]];
    }
    return [[header,cellText(cell,header)]];
  };
  const readCells = (headers,cells) => {
    const fields=Object.fromEntries(headers.flatMap((header,index)=>readCell(header,cells[index])));
    if(cells.some(cell=>cell.matches('td.art-table-cell'))){
      fields['原列表可编辑字段']=headers.filter((header,index)=>{
        const cell=cells[index];
        if(!header||!visible(cell))return false;
        const editor=[...cell.querySelectorAll('select,input:not([type="hidden"]),textarea,[role="combobox"]')]
          .some(control=>visibleControl(control)&&!control.closest('[disabled],[readonly],[aria-disabled="true"]'));
        return editor||[...cell.querySelectorAll('svg use')].some(icon=>
          (icon.getAttribute('href')||icon.getAttribute('xlink:href'))==='#icon-bianji1'&&
          !icon.closest('[hidden],[disabled],[aria-disabled="true"]')&&
          (visible(icon.closest('svg'))||getComputedStyle(icon).cursor==='pointer'));
      }).join('\n');
    }
    return fields;
  };
  const rows = [];
  for (const table of document.querySelectorAll('table')) {
    if (!visible(table)) continue;
    let headers = [...table.querySelectorAll('thead th, thead td')].map(heading);
    if(!headers.includes('内部订单号')){
      let parent=table.parentElement;
      for(let depth=0;parent&&depth<5;depth++,parent=parent.parentElement){
        const candidates=[...parent.querySelectorAll('thead')].map(head=>[...head.querySelectorAll('th,td')].map(heading));
        const found=candidates.find(h=>h.includes('内部订单号'));if(found){headers=found;break;}
      }
    }
    if (!headers.includes('内部订单号')) continue;
    for (const tr of table.querySelectorAll('tbody tr')) {
      if (!visible(tr)) continue;
      const cells = [...tr.children].filter(x => ['TD','TH'].includes(x.tagName));
      if (cells.length !== headers.length) continue;
      const values = readCells(headers,cells);
      const id = values['售后单号']?.match(/\d{4,40}/)?.[0];
      if (!id) continue;
      const recordingStatus = readRecordingStatus?.(tr,headers);
      rows.push({ afterSaleId: id, internalOrderId: values['内部订单号']?.match(/\d{4,40}/)?.[0] || '', fields: Object.fromEntries(labels.filter(k => Object.hasOwn(values,k)).map(k => [k,values[k]])), ...(recordingStatus?{recordingStatus}:{}) });
    }
  }
  // Archived after-sales use the original JT div grid, not the modern HTML table.
  const headerRows=new Set([...document.querySelectorAll('._jt_cell_head')].map(e=>e.parentElement));
  for(const head of headerRows){
    const headers=[...head.children].map(heading);
    if(!headers.includes('售后单号')||!headers.includes('内部订单号'))continue;
    let scope=head.parentElement;for(let i=0;scope&&!scope.querySelector('._jt_row')&&i<4;i++)scope=scope.parentElement;
    if(!scope)continue;
    for(const row of scope.querySelectorAll('._jt_row')){
      if(!visible(row))continue;const cells=[...row.children];if(cells.length!==headers.length)continue;
      const values=readCells(headers,cells);
      const id=values['售后单号']?.match(/\d{4,40}/)?.[0],order=values['内部订单号']?.match(/\d{4,40}/)?.[0];
      if(id){
        const recordingStatus=readRecordingStatus?.(row,headers);
        rows.push({afterSaleId:id,internalOrderId:order||'',fields:Object.fromEntries(labels.filter(k=>Object.hasOwn(values,k)).map(k=>[k,values[k]])),...(recordingStatus?{recordingStatus}:{})});
      }
    }
  }
  // The original OrderEditor detail opens in a nested frame. Read labelled sections only.
  const detail = [];
  if (/OrderEditor/i.test(location.pathname)) {
    const text = String(document.body?.innerText || '').slice(0,500000);
    const internalOrderId = text.match(/(?:内部订单号|订单编号)\s*[:：]?\s*(\d{4,40})/)?.[1] || '';
    const matches = [...text.matchAll(/售后单号\s*[:：]?\s*(\d{4,40})/g)];
    // Some order details have no after-sales section. In that case the visible
    // internal order number must still match the order located from the OA case.
    if(!matches.length&&internalOrderId&&order?.internalOrderId===internalOrderId&&/^\d{4,40}$/.test(order.afterSaleId))
      matches.push({1:order.afterSaleId,index:0});
    for (let i=0;i<matches.length;i++) {
      const match=matches[i];
      const logsAt=text.indexOf('订单操作进程及日志',match.index);
      const section=text.slice(match.index,matches[i+1]?.index ?? (logsAt<0?text.length:logsAt));
      const fields = {};
      const saleFields=new Set(['申请时间','线上类型','线上状态','售后单状态','货物状态','线上申请金额','实退金额','售后标签','售后分类','退货快递单号','收货仓','线上售后单号','售后问题类型','售后问题登记']);
      const aliases={'线上申请金额':'申请金额','申请时间':'申请日期','退货快递单号':'退回快递单号'};
      const listOnly = new Set(['商品信息','售后日志','订单操作日志','供应商售后单状态','供应商退款状态',
        '修改时间','付款时间','退货金额','买家应补运费','拒绝原因','平台卖家退货地址','退货物流状态',
        '售后商品明细','实退金额明细','退货物流明细','发货物流明细','平台售后记录']);
      for (const k of labels.filter(k => !listOnly.has(k))) {
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
  for (const f of frames) for (const r of f.rows) {
    const prior = rows.get(r.afterSaleId);
    if (prior?.internalOrderId && r.internalOrderId && prior.internalOrderId !== r.internalOrderId) continue;
    rows.set(r.afterSaleId,{...r,internalOrderId:r.internalOrderId||prior?.internalOrderId||'',fields:{...prior?.fields,...r.fields},sourceCompany:company,capturedAt:new Date().toISOString()});
  }
  for (const f of frames) for (const d of f.detail) {
    const r = rows.get(d.afterSaleId);
    if (r && r.internalOrderId && d.internalOrderId && r.internalOrderId !== d.internalOrderId) continue;
    rows.set(d.afterSaleId,{...r,...d,internalOrderId:d.internalOrderId || r?.internalOrderId || '',fields:{...r?.fields,...d.fields},sourceCompany:company,capturedAt:new Date().toISOString()});
  }
  return [...rows.values()];
}
function openVisibleOrder(id, afterSaleId, kind='order') {
  const column=kind==='sale'?'售后单号':'内部订单号';
  const click=element=>{const r=element.getBoundingClientRect();for(const type of ['mousedown','mouseup','click']){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==='mousedown'?1:0,clientX:r.x+r.width/2,clientY:r.y+r.height/2});Object.defineProperty(event,'which',{value:1});element.dispatchEvent(event);}};
  const rowMatches=(headings,row)=>{
    if(!row.getClientRects().length)return false;
    if(!afterSaleId)return true;
    const saleIndex=headings.indexOf('售后单号');
    return saleIndex>=0&&row.children[saleIndex]?.innerText.match(/\d{4,40}/)?.[0]===afterSaleId;
  };
  for (const table of document.querySelectorAll('table')) {
    let heads=[...table.querySelectorAll('thead th,thead td')].map(e=>e.innerText.trim().split('\n')[0]);
    if(!heads.includes(column)){let parent=table.parentElement;for(let depth=0;parent&&depth<5;depth++,parent=parent.parentElement){const candidate=[...parent.querySelectorAll('thead')].map(h=>[...h.querySelectorAll('th,td')].map(e=>e.innerText.trim().split('\n')[0])).find(h=>h.includes(column));if(candidate){heads=candidate;break;}}}
    const index=heads.indexOf(column);if(index<0)continue;
    for(const row of table.querySelectorAll('tbody tr')){
      if(!rowMatches(heads,row))continue;
      const cell=row.children[index];if(!cell)continue;
      const link=[...cell.querySelectorAll('a,button,[role="button"]')].find(e=>e.textContent.match(/\d{4,40}/)?.[0]===id&&e.getClientRects().length);
      if(link){click(link);return true;}
    }
  }
  for(const head of new Set([...document.querySelectorAll('._jt_cell_head')].map(e=>e.parentElement))){
    const headers=[...head.children].map(e=>String(e.innerText||'').trim().split('\n')[0]);const index=headers.indexOf(column);if(index<0)continue;
    let scope=head.parentElement;for(let i=0;scope&&!scope.querySelector('._jt_row')&&i<4;i++)scope=scope.parentElement;
    for(const row of scope?.querySelectorAll('._jt_row')??[]){const cell=row.children[index];if(!rowMatches(headers,row)||!cell||String(cell.innerText||'').match(/\d{4,40}/)?.[0]!==id)continue;const link=[...cell.querySelectorAll('a,button,[onclick],[role="button"]')].find(e=>e.textContent.match(/\d{4,40}/)?.[0]===id&&e.getClientRects().length);if(link){click(link);return true;}if(kind==='sale')continue;const leaf=[...cell.querySelectorAll('span,div')].find(e=>e.children.length===0&&e.textContent.match(/\d{4,40}/)?.[0]===id&&e.getClientRects().length);if(leaf){click(leaf);return true;}click(cell);return true;}
  }
  return false;
}
module.exports = { extractVisible, mergeFrames, openVisibleOrder };
