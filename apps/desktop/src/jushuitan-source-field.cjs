'use strict';

// Serialized into the verified source frame. Activate only exact, row-scoped controls.
function locateJushuitanField(afterSaleId, column, openVideo = false, action = 'locate') {
  const aliases = {
    '退回快递单号(运单号)':'退货快递单号', '原订单快递单号':'发货快递单号',
    '标记|多标签':'售后标签', '问题类型':'售后问题类型',
    '售后问题登记(图片/线下备注)':'售后问题登记', '买家帐号':'买家账号',
    '原订单备注':'原订单备注/旗帜', '原订单便签｜线下备注':'原订单线下备注',
  };
  const text = element => String(element?.innerText ?? element?.textContent ?? '').trim();
  const visible = element => !!element?.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const heading = element => {
    const name = text(element).split('\n')[0].replace(/^商品信息\s*展示设置.*$/, '商品信息');
    return aliases[name] || name;
  };
  const validHeaders = headings => headings.includes('售后单号') && (openVideo || headings.includes(column));
  const controls = 'button,a,[role="button"],[onclick]';
  const enabled = element => !element.closest('[disabled],[aria-disabled="true"],[hidden]');
  const pencilColumns = new Set(['原订单备注/旗帜','原订单线下备注','售后标签','售后问题登记','退货快递单号']);
  function activate(element) {
    element.scrollIntoView?.({block:'center',inline:'center'});
    if (typeof element.click === 'function') element.click();
    else element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    return true;
  }
  function iconControls(cell, name, buttonOnly = false) {
    const icons = [...cell.querySelectorAll('svg use')].filter(icon =>
      (icon.getAttribute('href') || icon.getAttribute('xlink:href')) === name);
    return [...new Set(icons.flatMap(icon=>{
      const control=icon.closest(buttonOnly?'button':'svg');
      if(!control||!cell.contains(control)||!enabled(control))return [];
      // The tag pencil is rendered before the row is hovered.
      return visible(control)||(!buttonOnly&&getComputedStyle(icon).cursor==='pointer')?[control]:[];
    }))];
  }
  function fieldControl(cell) {
    if(action==='attachment'&&['售后问题登记','供分销备注'].includes(column)){
      return iconControls(cell,'#icon-dingdandaochu3',true).filter(button=>{
        const label=[text(button),button.title,button.getAttribute('aria-label')].join(' ');
        return /下载/.test(label)&&!/上传/.test(label);
      });
    }
    if(action!=='open')return [];
    if(pencilColumns.has(column))return iconControls(cell,'#icon-bianji1');
    if(column==='操作'||column==='拒绝原因'){
      const label=column==='操作'?'编辑':'查看';
      return [...cell.querySelectorAll('button')].filter(el=>visible(el)&&enabled(el)&&text(el)===label);
    }
    return [];
  }
  const exactVideoLabel = /^(?:(?:查看\s*)?(?:视频监控|监控视频|录像回放|监控回放)|点击观看视频)$/;
  const hasVideoLabel = element => {
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id=>text(document.getElementById(id))).filter(Boolean).join(' ');
    return [text(element), labelledBy, text(element.querySelector('svg title')),
      element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-original-title')]
      .some(value=>value && exactVideoLabel.test(value.trim()));
  };

  function activateVideo(row) {
    const elements = row.querySelectorAll(`${controls},[aria-label],[aria-labelledby],[title],[data-original-title]`);
    const candidates = new Set();
    for (const element of elements) {
      if (!visible(element) || !hasVideoLabel(element)) continue;
      const ancestor = element.closest(controls);
      const control = ancestor && ancestor!==row && row.contains(ancestor) ? ancestor :
        (getComputedStyle(element).cursor === 'pointer' ? element : null);
      if (control && row.contains(control) && visible(control) &&
          !control.closest('[disabled],[aria-disabled="true"],[hidden],[aria-hidden="true"]')) {
        candidates.add(control);
      }
    }
    const unique = [...candidates].filter(element=>![...candidates].some(other=>other!==element&&other.contains(element)));
    if (unique.length !== 1) return false;
    return activate(unique[0]);
  }

  function selectCell(rows, headings) {
    const idIndex = headings.indexOf('售后单号');
    const columnIndex = headings.indexOf(column);
    for (const row of rows) {
      if (!visible(row) || row.children.length !== headings.length) continue;
      const idCell = row.children[idIndex];
      const id = text(idCell).match(/^(?:售后单号\s*[:：]?\s*)?(\d{4,40})$/)?.[1];
      const exactIdControl = [...idCell.querySelectorAll(controls)].some(element=>visible(element)&&text(element)===afterSaleId);
      if (id !== afterSaleId && !exactIdControl) continue;
      if (openVideo) return activateVideo(row);
      const cell = row.children[columnIndex];
      if (!visible(cell)) continue;
      if(action==='attachment'||(action==='open'&&(pencilColumns.has(column)||column==='操作'||column==='拒绝原因'))){
        const matches=fieldControl(cell);
        return matches.length===1&&activate(matches[0]);
      }
      const editor = column === '操作'
        ? [...cell.querySelectorAll('button,a,[role="button"]')].find(element => visible(element) && text(element) === '编辑')
        : undefined;
      (editor || cell).scrollIntoView?.({block:'center', inline:'center'});
      if (cell.hasAttribute('data-oa-source-field')) return true;
      const previousOutline = cell.style.outline;
      const previousOffset = cell.style.outlineOffset;
      cell.setAttribute('data-oa-source-field', '');
      cell.style.outline = '2px solid #1677ff';
      cell.style.outlineOffset = '-2px';
      setTimeout(()=>{
        cell.style.outline = previousOutline;
        cell.style.outlineOffset = previousOffset;
        cell.removeAttribute('data-oa-source-field');
      }, 5500);
      return true;
    }
    return false;
  }

  const headersOf = table => [...(table.tHead?.rows[0]?.cells ?? [])].map(heading);
  for (const table of document.querySelectorAll('table')) {
    if (!visible(table) || table.closest('[role="dialog"], .ant-modal, .ant-drawer-content, .ant-popover')) continue;
    let headings = headersOf(table);
    for (let scope=table.parentElement, depth=0; !validHeaders(headings) && scope && depth<5; scope=scope.parentElement, depth++) {
      headings = [...scope.querySelectorAll('table')].map(headersOf).find(validHeaders) || [];
    }
    if (!validHeaders(headings)) continue;
    const rows = [...table.tBodies].flatMap(body=>[...body.rows]);
    if (selectCell(rows, headings)) return true;
  }

  const legacyHeaders = new Set([...document.querySelectorAll('._jt_cell_head')].map(element=>element.parentElement));
  for (const header of legacyHeaders) {
    const headings = [...header.children].map(heading);
    if (!validHeaders(headings)) continue;
    let scope = header.parentElement;
    for (let depth=0; scope && !scope.querySelector('._jt_row') && depth<4; depth++) scope=scope.parentElement;
    if (scope && selectCell(scope.querySelectorAll('._jt_row'), headings)) return true;
  }
  return false;
}

module.exports = { locateJushuitanField };
