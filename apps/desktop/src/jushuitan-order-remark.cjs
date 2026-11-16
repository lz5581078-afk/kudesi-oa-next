'use strict';
const {allowedJst}=require('./security.cjs');

// Executed only inside the verified after-sales frame. Do not change the flag radios.
function remarkForm(action, expected, remark, flag) {
 const visible=node=>!!node?.getClientRects().length&&getComputedStyle(node).visibility!=='hidden';
 const forms=[...document.querySelectorAll('.ant-modal-content')].filter(node=>visible(node)&&
  node.querySelector('.ant-modal-title')?.textContent.replace(/\s/g,'')==='编辑卖家备注/旗帜');
 if(action==='closed')return forms.length===0;
 if(forms.length!==1)return null;
 const form=forms[0],fields=[...form.querySelectorAll('textarea')].filter(visible);
 if(fields.length!==1||fields[0].disabled||fields[0].readOnly)return null;
 const field=fields[0],selected=[...form.querySelectorAll('input[type=radio]:checked')];
 if(selected.length>1)return null;
 const currentFlag=selected[0]?.value??'unchanged';
 const value=field.value.replace(/\r\n?/g,'\n');
 if(action==='read')return {remark:value,flag:currentFlag};
 if(action==='fill'){
  if(value!==expected||currentFlag!==flag)throw new Error('聚水潭原备注或旗帜已变化，请重新读取后修改');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,remark);
  field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
 }
 if(action==='submit'){
  if(value!==remark||currentFlag!==flag)throw new Error('聚水潭待保存内容已变化');
  const buttons=[...form.querySelectorAll('button')].filter(node=>visible(node)&&!node.disabled&&node.textContent.replace(/\s/g,'')==='保存');
  if(buttons.length!==1)return false;
  buttons[0].click();return true;
 }
 return null;
}
async function wait(check,message){
 const end=Date.now()+12000;
 while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,250));}
 throw new Error(message);
}
function validIdentity(task){
 if(!task||typeof task.sourceCompany!=='string'||!task.sourceCompany||task.sourceCompany.length>100||
  !/^\d{4,40}$/.test(task.afterSaleId)||!/^\d{4,40}$/.test(task.internalOrderId))throw new Error('订单身份无效');
}
async function editor(window,task,locate,reload=false){
 const {frame,original}=await locate(window,task,reload);
 const run=(action,expected,remark,flag)=>{
  if(!allowedJst(frame.url,{subframe:true})||!new URL(frame.url).pathname.toLowerCase().includes('aftersales'))throw new Error('聚水潭售后页面已变化');
  return frame.executeJavaScript('('+remarkForm.toString()+')(...'+JSON.stringify([action,expected,remark,flag])+')');
 };
 const value=await wait(()=>run('read'),'未找到唯一的卖家备注编辑框');
 return {run,value,original};
}
async function readOrderRemark({input,open,company,locate}){
 validIdentity(input);let window;
 try{
  window=await open();if(await company(window)!==input.sourceCompany)throw new Error('聚水潭登录公司与售后来源不一致');
  const {value,original}=await editor(window,input,locate);
  if(await company(window)!==input.sourceCompany)throw new Error('聚水潭登录公司已变化');
  return {afterSaleId:input.afterSaleId,internalOrderId:input.internalOrderId,sourceCompany:input.sourceCompany,remark:original.remark,flag:value.flag};
 }finally{if(window&&!window.isDestroyed())window.destroy();}
}
async function executeOrderRemark({origin,input,open,company,locate}){
 if(!input||!Number.isSafeInteger(input.id)||input.id<1||!/^[a-f0-9]{64}$/.test(input.permit??''))throw new Error('备注任务无效');
 const request=async(phase,extra={})=>{
  const response=await fetch(new URL('/api/desktop-after-sales/order-remark-client/'+input.id+'/'+phase,origin),{
   method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({permit:input.permit,...extra}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('OA 无法领取或确认备注任务，请核对任务状态');return response.json();
 };
 const task=await request('prepare');validIdentity(task);
 if(typeof task.expected!=='string'||typeof task.remark!=='string'||task.expected.length>500||task.remark.length>500||task.expected===task.remark)throw new Error('备注任务内容无效');
 let window,started=false,receipt;
 try{
  window=await open();if(await company(window)!==task.sourceCompany)throw new Error('聚水潭登录公司与售后来源不一致');
  const {run,value,original}=await editor(window,task,locate);
  if(original.remark!==task.expected)throw new Error('聚水潭原备注已变化，请重新读取后修改');
  if(!task.remark.trim())throw new Error('聚水潭此入口不支持清空备注，请打开原字段处理');
  if(!await run('fill',value.remark,task.remark,value.flag))throw new Error('无法填写聚水潭备注');
  if(await company(window)!==task.sourceCompany)throw new Error('聚水潭登录公司已变化');
  await request('begin');started=true;
  if(!await run('submit',task.expected,task.remark,value.flag))throw new Error('未找到唯一的保存按钮');
  await wait(()=>run('closed'),'聚水潭未确认保存，请重新读取核对');
  // A new navigation and exact order lookup are required; the filled textarea is not a receipt.
  const verified=await editor(window,task,locate,true);
  if(await company(window)!==task.sourceCompany||verified.original.remark!==task.remark||verified.value.flag!==value.flag)throw new Error('聚水潭保存后回读不一致，请核对原备注');
  receipt={submitted:true,result:'succeeded',observed:verified.original.remark};
  return await request('result',receipt);
 }catch(error){
  try{const result=await request('result',receipt??{submitted:started,result:started?'unknown':'failed'});if(receipt)return result;}catch{/* Never repeat a submission after an uncertain response. */}
  throw error;
 }finally{if(window&&!window.isDestroyed())window.destroy();}
}
module.exports={remarkForm,readOrderRemark,executeOrderRemark};
