'use strict';

function isRecoveryHomeFrame(href) {
  try {
    const url = new URL(href);
    return url.origin === 'https://src.erp321.com' && url.pathname === '/erp-web-group/home/' && url.hash.startsWith('#/erp-home');
  } catch { return false; }
}

/** Run only inside the allowlisted ERP home frame. No fetch, credentials or storage access. */
function interactWithRecoveryForm(action, numbers) {
  const clean = node => (node?.innerText || node?.textContent || '').replace(/\s+/g,'').trim();
  const visible = node => !!node?.getClientRects().length &&
    getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden],[aria-hidden="true"]');
  const matches = (root, selector, text) => [...root.querySelectorAll(selector)].filter(
    node => visible(node) && clean(node) === text,
  );
  const clickOnly = nodes => {
    if (nodes.length !== 1) return false;
    nodes[0].click();
    return true;
  };
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  if (action === 'read') {
    const results = dialogs.filter(dialog => /^(单号回收成功|单号回收失败|单号回收结果)$/.test(
      clean(dialog.querySelector('.ant-modal-title,[class$="-modal-title"],[id^="rcDialogTitle"]')),
    ));
    if (results.length !== 1) return null;
    const result = results[0];
    const text = clean(result);
    const failed = [...result.querySelectorAll('tbody tr,[role="row"]')].filter(visible).flatMap(row => {
      const cells = row.querySelectorAll('td,[role="cell"],[role="gridcell"]');
      const code = clean(cells[0]).toUpperCase();
      return /^[A-Z]{0,20}\d{10,20}$/.test(code) && cells.length >= 2
        ? [{number:code,message:clean(cells[1]).slice(0,240)}] : [];
    });
    const complete = text.match(/成功回收(\d+)个快递单号/);
    const mixed = text.match(/回收成功(\d+)[,，]回收失败(\d+)[,，]不存在(\d+)/);
    const rejected = text.match(/(\d+)个快递单号回收失败/);
    if (complete) return {success:Number(complete[1]), failedCount:0, missing:0, failed};
    if (mixed) return {success:Number(mixed[1]), failedCount:Number(mixed[2]), missing:Number(mixed[3]), failed};
    if (rejected) return {success:0, failedCount:Number(rejected[1]), missing:0, failed};
    return null;
  }
  const forms=dialogs.filter(dialog => clean(dialog.querySelector('.ant-modal-title,[class$="-modal-title"],[id^="rcDialogTitle"]'))==='单号回收');
  const form=forms.length===1?forms[0]:null;
  const field=form?.querySelector('#WayBillCodes');
  const platform=form?.querySelector('#LIdType');
  const selector=platform?.closest('.ant-select,.jst-erp-select,.ant-cascader,.ant-cascader-picker')
    ?? platform?.parentElement;
  const force=[...(form?.querySelectorAll('label')??[])].find(label=>visible(label)&&clean(label)==='忽略订单状态强制回收');
  const forceInput=force?.querySelector('input[type="checkbox"]');
  const selected=selector?.querySelector('.ant-select-selection-item,.ant-cascader-picker-label,[class*="selection-item"]');
  const selectedText=clean(selected || selector);
  const selectedPlatform=selectedText==='不限平台' || platform?.value==='不限平台';
  const exactNumbers=field?.value.split(/[\s,，]+/).filter(Boolean).join('\n')===numbers.join('\n');

  if(action==='open') {
    if(form) return true;
    return clickOnly(matches(document,'button,a,span,div,p','单号回收').filter(node=>!node.children.length));
  }
  if(!form) return false;
  if(action==='platform') {
    if(!visible(field) || !platform) return false;
    if(selectedPlatform) return true;
    const opener=selector?.querySelector('.ant-select-selector,[class$="-select-selector"],.ant-cascader-picker-label') ?? selector ?? platform;
    if(!visible(opener)) return false;
    if(platform.getAttribute('aria-expanded')==='true') return true;
    if ([...opener.classList].some(name=>name.endsWith('-select-selector'))) {
      opener.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
    } else {
      opener.click();
    }
    return true;
  }
  if(action==='choose') {
    if(selectedPlatform) return true;
    const options=matches(document,'[role="option"],.ant-select-item-option,[class*="-select-item-option"],.ant-cascader-menu-item','不限平台');
    return clickOnly(options.filter(node=>!options.some(other=>other!==node && node.contains(other))));
  }
  if(action==='fill') {
    if(!visible(field) || !forceInput || !selectedPlatform) return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
    if(!setter || !(field instanceof HTMLTextAreaElement)) return false;
    setter.call(field,numbers.join('\n'));
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.dispatchEvent(new Event('change',{bubbles:true}));
    if(!forceInput.checked) force.click();
    return true;
  }
  if(action==='ready' || action==='submit') {
    if (!visible(field) || !selectedPlatform || !forceInput?.checked || !exactNumbers) return false;
    const buttons=matches(form,'button','确认').filter(button=>!button.disabled);
    if (action==='ready') return buttons.length===1;
    return clickOnly(buttons);
  }
  return false;
}

function recoveryRows(numbers, result) {
  const unknown = number => ({number,status:'unknown',message:'聚水潭未返回可确认的回执'});
  if (!result || !Array.isArray(result.failed) ||
    ![result.success,result.failedCount,result.missing].every(n=>Number.isInteger(n)&&n>=0) ||
    result.success+result.failedCount+result.missing!==numbers.length) return numbers.map(unknown);
  const failed=new Map();
  for(const row of result.failed) {
    if(!numbers.includes(row.number) || failed.has(row.number)) return numbers.map(unknown);
    failed.set(row.number,row.message);
  }
  if(failed.size>result.failedCount) return numbers.map(unknown);
  const allRemainingSucceeded=result.missing===0 && failed.size===result.failedCount;
  return numbers.map(number => {
    // ERP does not identify absent numbers in a mixed aggregate.
    if(failed.has(number)) return {number,status:'failed',message:failed.get(number)||'聚水潭回收失败'};
    if(allRemainingSucceeded) return {number,status:'succeeded'};
    if(result.success===0 && failed.size===result.failedCount) {
      return {number,status:'failed',message:'聚水潭未找到这个运单号'};
    }
    return unknown(number);
  });
}

async function waitFor(check, timeoutMs, message) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const result=await check();
    if(result) return result;
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  throw new Error(message);
}

async function executeWaybillRecovery({origin,input,open,company}) {
  if(!input || !Number.isSafeInteger(input.id) || input.id<1 || !/^[a-f0-9]{64}$/.test(input.permit??'')) {
    throw new Error('运单回收任务无效');
  }
  const request=async (phase, extra={})=>{
    const response=await fetch(new URL('/api/desktop-after-sales/waybill-recovery/'+input.id+'/'+phase,origin),{
      method:'POST',redirect:'error',headers:{'content-type':'application/json'},
      body:JSON.stringify({permit:input.permit,...extra}),signal:AbortSignal.timeout(10_000),
    });
    if(!response.ok) throw new Error(phase==='begin'?'OA 未能领取回收任务，请查看运单状态':'OA 无法读取或保存回收任务');
    return response.json();
  };
  const task=await request('prepare');
  if(!task.sourceCompany || !Array.isArray(task.numbers) || !task.numbers.length || task.numbers.length>100
    || task.numbers.some(number=>typeof number!=='string'||!/^[A-Z]{0,20}\d{10,20}$/.test(number))) {
    throw new Error('OA 回收任务内容无效');
  }
  let window;
  let started=false;
  let receipt;
  try {
    window=await open();
    const signedInCompany=await company(window);
    if(!signedInCompany) throw new Error('请先登录聚水潭，再回收单号');
    if(signedInCompany!==task.sourceCompany) throw new Error('聚水潭登录公司与售后来源不一致');
    const frame=await waitFor(()=>window.webContents.mainFrame.framesInSubtree.find(item=>isRecoveryHomeFrame(item.url)),
      12_000,'未找到聚水潭首页');
    const step=action => {
      if(!isRecoveryHomeFrame(frame.url)) throw new Error('聚水潭首页已变化');
      return frame.executeJavaScript('('+interactWithRecoveryForm.toString()+')(...'+JSON.stringify([action,task.numbers])+')');
    };
    if(!await step('open')) throw new Error('未找到唯一的聚水潭单号回收入口');
    await waitFor(()=>step('platform'),8_000,'聚水潭未打开按单回收表单');
    await waitFor(()=>step('choose'),6_000,'当前聚水潭未提供「不限平台」选项');
    await waitFor(()=>step('fill'),5_000,'未能填写指定运单或勾选强制回收');
    await waitFor(()=>step('ready'),5_000,'表单单号、平台或强制回收选项核对失败');
    if(await company(window)!==task.sourceCompany) throw new Error('聚水潭登录公司已变化');
    await request('begin');
    started=true;
    if(!await step('submit')) throw new Error('提交前聚水潭页面已变化');
    const result=await waitFor(()=>step('read'),10*60_000,'聚水潭回执未确认，请到单号回收详情核对');
    receipt=recoveryRows(task.numbers,result);
    return await request('result',{submitted:true,rows:receipt});
  } catch(error) {
    // A broken or delayed response after beginning must never cause a second submission.
    try {
      const rows=await request('result',{submitted:started,rows:receipt??[]});
      if(receipt) return rows;
    } catch { /* OA retains the pending or uncertain result when transport is interrupted. */ }
    throw error;
  } finally {
    if(window && !window.isDestroyed()) window.destroy();
  }
}

module.exports = {executeWaybillRecovery, interactWithRecoveryForm, isRecoveryHomeFrame, recoveryRows};
