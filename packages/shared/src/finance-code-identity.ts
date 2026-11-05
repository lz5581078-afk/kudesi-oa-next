/** Persisted codes identify goods in compositions and external systems. */
export type FinanceIdentityRecord = {status:string;data:Record<string,unknown>};
const value=(v:unknown)=>typeof v==='string'?v:'';
/** Only confirmed upload evidence freezes a code; verification and queues do not. */
export function uploadedFinanceCode(record:FinanceIdentityRecord|null|undefined):boolean {
 return !!record&&(record.data._financeCodeUploaded===true||!!value(record.data.jstUploadedCode).trim()||record.data.jstStatus==='synced');
}
export function frozenBundleCode(record:FinanceIdentityRecord|null|undefined):boolean {
 return uploadedFinanceCode(record)&&!!value(record?.data.code);
}
export function fixedFinanceCodeFields(type:string,record:FinanceIdentityRecord|null|undefined):string[] {
 return ['finance-products','finance-base-codes','finance-bundles'].includes(type)&&uploadedFinanceCode(record)&&!!value(record?.data.code)?['code']:[];
}
export function changedFinanceCodeFields(type:string,record:FinanceIdentityRecord|null|undefined,input:Record<string,unknown>):string[] {
 if(!record)return [];
 const fields=fixedFinanceCodeFields(type,record),changed=fields.filter(key=>Object.hasOwn(input,key)&&value(input[key]).trim()!==value(record.data[key]).trim());
 if(type==='finance-bundles'&&frozenBundleCode(record))for(const [manual,key]of [['manualCode','code']]){
  if(Object.hasOwn(input,manual)&&value(input[manual]).trim()!==value(record.data[manual]).trim()&&value(input[manual]).trim()!==value(record.data[key]).trim())changed.push(manual);
 }
 return changed;
}
export function retainFinanceCodeIdentity(type:string,record:FinanceIdentityRecord|null|undefined,data:Record<string,unknown>):void {
 if(!record)return;
 for(const key of fixedFinanceCodeFields(type,record))data[key]=record.data[key];
 if(['finance-products','finance-base-codes','finance-bundles'].includes(type)&&(uploadedFinanceCode(record)||uploadedFinanceCode({status:record.status,data})))data._financeCodeUploaded=true;
}
