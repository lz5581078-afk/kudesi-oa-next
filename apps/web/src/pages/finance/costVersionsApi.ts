import { api } from '../../api/client';
import type { CostRow } from './financeApi';

export interface VersionCostRow extends CostRow { settingId: number; skuType: string; skuId: number; buckets: Record<string,number | null>; markupPercent: number; costVersionId: number; warnings?:string[] }
export interface VersionPreview { rows: VersionCostRow[]; signature: string; ready: boolean; issues: string[]; locked: boolean; warnings?:string[]; activationSignature?:string;transition?:{id:number;name:string;effectiveTo:string} | null }
export interface CostSkuOption {skuType:string;skuId:number;code:string;name:string;weightG:number | null;buckets:Record<string,number>;warnings:string[]}
export interface CostSkuOptions {rows:CostSkuOption[];total:number;page:number;pageSize:number}
export interface SourcePreview { rows: Array<{skuType:string;skuId:number;code:string;name:string}>; signature: string }
export interface RecalculationPreview { rows:Array<{skuType:string;skuId:number;code:string;name:string;settingId:number | null;previous:number | null;proposed:number | null;issues:string[]}>;signature:string;ready:boolean;issues:string[];businessDate:string;changed:number; warnings?:string[] }
export const costVersionsApi = {
  skuOptions:(id:number,query:{skuType:string;keyword:string;page:number})=>api<CostSkuOptions>(`/finance/cost-versions/${id}/sku-options?${new URLSearchParams({...query,page:String(query.page)})}`),
  preview: (id: number) => api<VersionPreview>(`/finance/cost-versions/${id}/preview`),
  recalculatePreview: (id:number)=>api<RecalculationPreview>(`/finance/cost-versions/${id}/recalculate-preview`),
  recalculate: (id:number,signature:string)=>api<{updated:number;created:number}>(`/finance/cost-versions/${id}/recalculate`,{method:'POST',body:{signature}}),
  sources: (id: number) => api<SourcePreview>(`/finance/cost-versions/${id}/sources`),
  register: (id: number,signature: string) => api<{created:number}>(`/finance/cost-versions/${id}/register-sources`,{method:'POST',body:{signature}}),
  activate: (id: number,signature: string) => api<{id:number}>(`/finance/cost-versions/${id}/activate`,{method:'POST',body:{signature}}),
  clear: (id: number,signature: string,confirmCode: string,reason: string) => api<{deleted:number}>(`/finance/cost-versions/${id}/clear`,{method:'POST',body:{signature,confirmCode,reason}}),
  copy: (id: number,versionCode: string,versionName: string) => api<{id:number}>(`/finance/cost-versions/${id}/copy`,{method:'POST',body:{versionCode,versionName}}),
  export: (id: number) => api<{fileName:string;fileBase64:string;rowCount:number}>(`/finance/cost-versions/${id}/export`),
};

export function downloadCostWorkbook(file: {fileName:string;fileBase64:string}) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.fileBase64),c=>c.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const link = document.createElement('a'); link.href = url; link.download = file.fileName; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
}
