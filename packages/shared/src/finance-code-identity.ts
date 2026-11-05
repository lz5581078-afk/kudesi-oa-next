/** Persisted codes identify goods in compositions and external systems. */
export type FinanceIdentityRecord = {status:string;data:Record<string,unknown>};
const value=(v:unknown)=>typeof v==='string'?v:'';
export function frozenBundleCode(record:FinanceIdentityRecord|null|undefined):boolean {
 if(!record||!value(record.data.code)||value(record.data.code).startsWith('ZH-待配置-'))return false;
 return record.data._financeCodeFrozen===true||['verified','reverify'].includes(record.status)||['verified','reverify'].includes(value(record.data.verificationState))||!!record.data.snapshot||!!record.data.jstUploadedCode||['synced','pending'].includes(value(record.data.jstStatus))||['external_import','历史导入'].includes(value(record.data.recordOrigin));
}
export function fixedFinanceCodeFields(type:string,record:FinanceIdentityRecord|null|undefined):string[] {
 if(!record)return [];
 const fields=type==='finance-products'?['code']:type==='finance-base-codes'?['code','styleCode']:type==='finance-bundles'&&frozenBundleCode(record)?['code','styleCode','mainStyleCode']:[];
 return fields.filter(key=>!!value(record.data[key]));
}
export function changedFinanceCodeFields(type:string,record:FinanceIdentityRecord|null|undefined,input:Record<string,unknown>):string[] {
 if(!record)return [];
 const fields=fixedFinanceCodeFields(type,record),changed=fields.filter(key=>Object.hasOwn(input,key)&&value(input[key]).trim()!==value(record.data[key]).trim());
 if(type==='finance-bundles'&&frozenBundleCode(record))for(const [manual,key]of [['manualCode','code'],['manualStyleCode','styleCode']]){
  if(Object.hasOwn(input,manual)&&value(input[manual]).trim()!==value(record.data[manual]).trim()&&value(input[manual]).trim()!==value(record.data[key]).trim())changed.push(manual);
 }
 return changed;
}
export function retainFinanceCodeIdentity(type:string,record:FinanceIdentityRecord|null|undefined,data:Record<string,unknown>):void {
 if(!record)return;
 for(const key of fixedFinanceCodeFields(type,record))data[key]=record.data[key];
 if(type==='finance-bundles'&&frozenBundleCode(record))data._financeCodeFrozen=true;
}
