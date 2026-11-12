'use strict';

// This function runs inside a permitted after-sales list frame.
async function readAfterSalesPanel(afterSaleId, kind, options = {}) {
  const logistics = {
    trigger: /^(查看物流|查看物流信息|查看物流轨迹|物流查询|快递查询|快递跟踪)$/,
    title: /^(查看物流|物流信息|物流详情|物流轨迹|快递查询|快递跟踪|物流[（(]快递[）)]跟踪信息)$/,
    headers: /^(时间|物流时间|更新时间|发生时间|物流信息|物流详情|物流状态|快递状态|状态|地点|描述|轨迹描述|物流描述|详情|内容|物流轨迹|查询结果)$/,
    waybill: true,
  };
  const panels = {
    goods: {
      column: '商品信息', trigger: '商品明细', title: /^商品明细/,
      headers: /^(商品信息|商品名称|商品编码|商品简称|款式编码|款编码|SKU|规格|颜色|尺码|类型|数量|申请数量|申请退货数量|退货数量|换货数量|实退数量|退款金额|申请退款金额|实退金额|实收数量(?:\/金额)?|实收金额|实际收货数量|实际收货金额|次品数量|线上金额|备注|原订单单价(?:\/采购价)?|原订单采购价|进仓时间|入库时间|单价|金额|商品金额)$/,
    },
    orderAmount: {column: '原订单下单金额', selector: '.anticon-ellipsis', hover: true},
    refusal: {column: '拒绝原因', trigger: '查看', title: /^拒绝原因$/},
    refund: {hover: true, column: '实退金额', trigger: '查看明细', title: /^(退款明细|实退金额明细|金额明细)$/},
    logs: {
      column: '操作', trigger: '查看日志', title: /^查看日志$/,
      headers: /^(时间|操作时间|操作人|操作|修改内容)$/,
    },
    tracking: {...logistics,column: '退货快递单号'},
    shipping: {...logistics,column: '发货快递单号'},
    platform: {
      column: '平台售后详情', trigger: /^(查看|查看详情|查看平台售后单详情|平台售后详情)$/, title: /^(平台售后详情|平台售后单详情|线上售后详情|提示)$/,
      headers: /^(线上售后单号|线上订单号|平台|店铺|线上状态|线上类型|申请时间|退款原因|拒绝原因|处理结果|备注)$/,
    },
  };
  const config = panels[kind];
  if (!Object.hasOwn(panels, kind)) return {error: '不支持的售后明细'};
  const read = el => String(el?.innerText ?? '').trim();
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' &&
    !el.closest('[hidden], [aria-hidden="true"]');
  const heading = cell => read(cell).replace(/\s*[/／]\s*/g, '/').split('\n')[0]
    .replace(/^商品信息\s*展示设置.*$/, '商品信息').replace(/^原订单快递单号$/, '发货快递单号')
    .replace(/^退回快递单号(?:[（(]运单号[）)])?$/, '退货快递单号');
  const headersOf = table => [...(table.tHead?.querySelectorAll('th,td') ?? [])].map(cell => visible(cell) ? heading(cell) : '');
  const bodyRows = table => [...table.tBodies].flatMap(body => [...body.rows]);
  function findHeadings(table, match) {
    const own = headersOf(table);
    if (own.length) return own;
    const group = table.closest('.ant-table, .ant-table-container') || table.parentElement?.parentElement;
    return [...(group?.querySelectorAll('table') ?? [])].map(headersOf).find(match) || [];
  }
  const panelSelector = '[role="dialog"], .ant-modal, .ant-drawer-content, .ant-popover, .ant-tooltip';
  // A background ERP view can retain the Ant leave animation in the DOM.
  const visiblePanel = panel => visible(panel) && ![...panel.classList].some(name => /-leave(?:-|$)/.test(name));
  const existing = new Set([...document.querySelectorAll(panelSelector)].filter(visiblePanel));
  const waybillPattern=/^(?=[A-Z0-9-]{6,40}$)[A-Z-]*\d[A-Z0-9-]*$/i;
  const providerAddress=(frame,waybill)=>{
    try{
      const source=new URL(frame.getAttribute('src'),location.href);
      if(source.origin!=='https://m.kuaidi100.com'||source.username||source.password)return '';
      const number=source.searchParams.get('nu')||waybill;
      if(!waybillPattern.test(number)||(waybill&&number.toUpperCase()!==waybill.toUpperCase()))return '';
      const path=/^\/(?:app\/query\/?|result\.(?:jsp|html))$/.test(source.pathname)?source.pathname:'/result.jsp';
      const result=new URL(path,source.origin);
      result.searchParams.set('nu',number);
      const carrier=source.searchParams.get('com');
      if(carrier&&/^[a-z0-9_-]{1,50}$/i.test(carrier))result.searchParams.set('com',carrier);
      const partner=source.searchParams.get('coname');
      if(partner&&/^[a-z0-9_-]{1,40}$/i.test(partner))result.searchParams.set('coname',partner);
      return result.href;
    }catch{return '';}
  };
  let trigger,sourceWaybill='';
  function findTrigger(headers,rows) {
    const idIndex = headers.indexOf('售后单号'), actionIndex = headers.indexOf(config.column);
    if (idIndex < 0 || actionIndex < 0) return;
    for (const row of rows) {
      const cells = [...row.children];
      if (!visible(row) || cells.length !== headers.length) continue;
      const id = read(cells[idIndex]).match(/^(?:售后单号\s*[:：]?\s*)?(\d{4,40})$/)?.[1];
      if (id !== afterSaleId) continue;
      if (config.selector) {
        const candidates = [...cells[actionIndex].querySelectorAll(config.selector)].filter(visible);
        if (candidates.length === 1) trigger = candidates[0];
        if (trigger) return;
        continue;
      }
      const candidates = [...cells[actionIndex].querySelectorAll('button,a,[role="button"],span')]
        .filter(element => visible(element) && [read(element), element.getAttribute('aria-label'), element.getAttribute('title')]
          .some(label => label && (typeof config.trigger === 'string' ? label === config.trigger : config.trigger.test(label))));
      const labelled = candidates.find(el => el.matches('button,a,[role="button"]')) || candidates.at(-1);
      if (config.waybill) {
        const cell=cells[actionIndex];
        const links=[...cell.querySelectorAll('button,a,[role="button"],span[onclick]')]
          .filter(el=>visible(el)&&waybillPattern.test(read(el)));
        const inputs=[...cell.querySelectorAll('input:not([type="password"],[type="hidden"])')].filter(visible).map(el=>el.value.trim());
        const numbers=new Set([...read(cell).split(/\s+/),...inputs,...links.map(read)]
          .filter(value=>waybillPattern.test(value)).map(value=>value.toUpperCase()));
        const expected=options.waybill?.toUpperCase();
        const number=expected||(numbers.size===1?[...numbers][0]:'');
        const exact=number&&links.find(link=>read(link).toUpperCase()===number);
        // Only use a generic tracking button when its cell identifies a single waybill.
        trigger=exact||((expected?numbers.size===1&&numbers.has(expected):numbers.size<=1)?labelled:undefined);
        if(trigger)sourceWaybill=number;
      }else{
        trigger=labelled;
      }
      if (trigger) return;
    }
  }
  for (const table of document.querySelectorAll('table')) {
    if (!visible(table) || table.closest(panelSelector)) continue;
    const headers = findHeadings(table, columns => columns.includes('售后单号') && columns.includes(config.column));
    findTrigger(headers,bodyRows(table));
    if (trigger) break;
  }
  if (!trigger&&config.waybill) {
    const headerRows=new Set([...document.querySelectorAll('._jt_cell_head')].map(cell=>cell.parentElement));
    for(const head of headerRows){
      const headers=[...head.children].map(heading);
      if(!headers.includes('售后单号')||!headers.includes(config.column))continue;
      let scope=head.parentElement;
      for(let depth=0;scope&&!scope.querySelector('._jt_row')&&depth<4;depth++)scope=scope.parentElement;
      if(scope)findTrigger(headers,scope.querySelectorAll('._jt_row'));
      if(trigger)break;
    }
  }
  if (!trigger) return {error: '原售后列表未显示这笔单据的明细入口', missingTrigger: true};

  const trackingDate = /^(?:19|20)\d{2}[-\/.年]\d{1,2}[-\/.月]\d{1,2}(?:\D|$)/;
  const trackingTimeLabel = /^(时间|物流时间|更新时间|发生时间)$/;
  const formatLine = values => values.map(([label,value]) =>
    label+'：'+value.replace(/\r?\n/g,'\n\t').replaceAll(' · ',' ·\u00a0')).join(' · ');
  function trackingTableLine(row) {
    // Some providers omit the status column or insert summary rows.
    const [time,...values]=[...row.cells].filter(visible).map(read);
    if(!trackingDate.test(time)||values.length<1||values.length>2)return [];
    const [status,description]=values.length===1?['',values[0]]:values;
    if(!status&&!description)return [];
    return [formatLine([['时间',time],['状态',status],['物流描述',description]].filter(([,value])=>value))];
  }
  function tableLines(panel) {
    const lines = [];
    for (const table of panel.querySelectorAll('table')) {
      if (!visible(table)) continue;
      const headings = findHeadings(table, columns => columns.filter(label => config.headers.test(label)).length >= 2);
      const permitted = headings.map((label, index) => ({label, index}))
        .filter(({label}) => config.headers.test(label));
      if (permitted.length < 2 && !config.waybill) continue;
      const time = config.waybill && permitted.find(({label}) => trackingTimeLabel.test(label));
      const footer = kind==='goods'?[...(table.tFoot?.rows??[])].filter(row=>/^(总计|合计)$/.test(read(row.cells[0]))):[];
      const valuesByRow = [...bodyRows(table),...footer].filter(visible).flatMap(row => {
        const cells = footer.includes(row)?[...row.cells].flatMap(cell=>[cell,...Array(cell.colSpan-1).fill(null)]):[...row.children];
        if (permitted.length < 2 || cells.length !== headings.length) return config.waybill ? trackingTableLine(row) : [];
        if (time && !trackingDate.test(read(cells[time.index]))) return [];
        const values = permitted.filter(({index}) => visible(cells[index])).map(({label, index}) => [
          config.waybill?({发生时间:'时间',快递状态:'状态',轨迹描述:'物流描述'})[label]??label:label, read(cells[index]),
        ]);
        // Indent wrapped source cells so their labels cannot start another table row.
        return values.some(([, value]) => value) ? [formatLine(values)] : [];
      });
      lines.push(...valuesByRow);
    }
    return lines;
  }
  function refundLines(panel) {
    const text = read(panel.querySelector('.ant-modal-body,.ant-popover-inner-content,.ant-tooltip-inner') || panel);
    // Restrict the popover to labelled monetary values in the actual refund breakdown.
    const labels = '商品应退金额|卖家应退运费|应退运费|优惠[/／]差额|优惠差额|卖家应补|换货金额|买家应补运费|买家应补|商家实退|实退金额';
    return [...text.matchAll(new RegExp('(?:^|\\s)(' + labels + ')\\s*[:：]?\\s*([¥￥]?\\s*-?\\d[\\d,]*(?:\\.\\d+)?)', 'g'))]
      .map(([, label, value]) => label + '：' + value.trim());
  }
  trigger.scrollIntoView?.({block:'nearest',inline:'center'});
  if(config.hover)trigger.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
  if(kind!=='orderAmount')trigger.click();
  let opened,providerTab,emptyLogistics;
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const candidates = [...document.querySelectorAll(panelSelector)].filter(panel => visiblePanel(panel) && !existing.has(panel));
      for (const panel of candidates) {
        const titleId = panel.getAttribute('aria-labelledby');
        const title = panel.getAttribute('aria-label') || read(titleId && document.getElementById(titleId)) ||
          read(panel.querySelector('.ant-modal-title,.ant-drawer-title,.ant-popover-title,h2,h3'));
        const refundPopover = kind === 'refund' && panel.matches('.ant-popover,.ant-tooltip') &&
          /商品应退金额/.test(read(panel)) && /应退运费|优惠/.test(read(panel));
        const orderAmountPopover = kind === 'orderAmount' && panel.matches('.ant-popover[class*="-overlaySale"]');
        if (!config.title?.test(title) && !refundPopover && !orderAmountPopover) continue;
        opened = panel;
        if(config.waybill&&options.queryProvider&&!providerTab){
          providerTab=[...panel.querySelectorAll('[role="tab"],.ant-tabs-tab')].find(el=>visible(el)&&read(el)==='快递100查询');
          if(!providerTab)return {error:'聚水潭没有显示快递100查询入口'};
          providerTab.click();
          if(!options.keepOpen)continue;
        }
        if(options.keepOpen&&!(kind==='platform'&&title==='提示'&&!/请确保该店铺为登录状态/.test(read(panel))))return {opened:true};
        if(kind==='platform'&&title==='提示'){
          const prompt=read(panel);
          const shop=prompt.match(/当前售后单所在店铺是[：:]\s*([^\n]+)/)?.[1]?.trim();
          if(shop&&/请确保该店铺为登录状态/.test(prompt))return {content:'店铺：'+shop};
          continue;
        }
        let contentRoot=panel;
        if(providerTab){
          const active=providerTab.getAttribute('aria-selected')==='true'||providerTab.closest('.ant-tabs-tab-active');
          if(!active)continue;
          const controlled=providerTab.getAttribute('aria-controls');
          contentRoot=(controlled&&document.getElementById(controlled))||panel.querySelector('.ant-tabs-tabpane-active');
          if(!visible(contentRoot)||!panel.contains(contentRoot))continue;
          const embedded=contentRoot.querySelector('iframe[src]');
          if(embedded&&visible(embedded)){
            const providerUrl=providerAddress(embedded,sourceWaybill);
            return providerUrl?{providerUrl}:{error:'快递100未提供当前运单可用的查询页'};
          }
        }else if(config.waybill){
          const activeTab=panel.querySelector('[role="tab"][aria-selected="true"][aria-controls]');
          const system=(activeTab&&document.getElementById(activeTab.getAttribute('aria-controls')))||
            panel.querySelector('.ant-tabs-tabpane-active');
          if(system&&panel.contains(system)&&visible(system))contentRoot=system;
        }
        if ([...contentRoot.querySelectorAll('.ant-spin-spinning,[aria-busy="true"]')].some(visible)) {
          emptyLogistics=undefined;
          continue;
        }
        if (kind === 'orderAmount' || kind === 'refusal') {
          const body=panel.querySelector(kind==='orderAmount'?'.ant-popover-inner-content':'.ant-modal-body');
          const content=read(body).replace(/[\u0000-\u0008]/g, '');
          if (content.length > 12000) return {error: '这笔售后明细过长，请在聚水潭查看完整记录'};
          if (content) return {content};
          continue;
        }
        const lines = kind === 'refund' ? refundLines(panel) : tableLines(contentRoot);
        if (config.waybill && !lines.length) {
          lines.push(...[...contentRoot.querySelectorAll('.ant-timeline-item-content')].filter(visible).map(read).filter(Boolean));
          if (!lines.length) {
            lines.push(...[...read(contentRoot).matchAll(/^\s*(查询结果|物流状态|状态)[：:]\s*([^\n]+)/gm)]
              .map(([, label, value]) => label + '：' + value.trim()));
          }
        }
        if (kind === 'platform' && !lines.length) {
          const labels = '线上售后单号|线上订单号|平台|店铺|线上状态|线上类型|申请时间|退款原因|拒绝原因|处理结果|备注';
          lines.push(...[...read(panel).matchAll(new RegExp('^\\s*(' + labels + ')[：:]\\s*([^\\n]+)', 'gm'))]
            .map(([, label, value]) => label + '：' + value.trim()));
        }
        if (lines.length) {
          const prefix=config.waybill&&sourceWaybill?'快递单号：'+sourceWaybill+'\n':'';
          const content = prefix+lines.join('\n').replace(/[\u0000-\u0008]/g, '');
          if (content.length > 12000) return {error: '这笔售后明细过长，请在聚水潭查看完整记录'};
          return {content};
        }
        const empty=[...contentRoot.querySelectorAll('.ant-empty-description,.ant-table-placeholder,.art-table-empty')].some(visible)||
          (config.waybill&&/暂无(?:物流|数据)|未查询到/.test(read(contentRoot)));
        if (empty&&!config.waybill) return {empty:true};
        if(config.waybill)emptyLogistics=empty?panel:undefined;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return (kind==='refusal'&&opened)||(emptyLogistics&&visiblePanel(emptyLogistics))?{empty:true}:{error: '聚水潭明细尚未加载或结构无法识别'};
  } finally {
    const close = opened?.querySelector('button[aria-label="Close"],button[aria-label="关闭"],button.ant-modal-close,button.ant-drawer-close');
    if (!options.keepOpen&&visible(close)) close.click();
    else if (!options.keepOpen&&opened?.matches('.ant-popover,.ant-tooltip')) {
      opened.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      if(config.hover){
        for(const element of [trigger,opened]){
          const event={bubbles:true,relatedTarget:document.body};
          element.dispatchEvent(new MouseEvent('mouseout',event));
          if(typeof PointerEvent==='function')element.dispatchEvent(new PointerEvent('pointerout',{...event,pointerType:'mouse'}));
        }
      }else trigger.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));
    }
  }
}

module.exports = {readAfterSalesPanel};
