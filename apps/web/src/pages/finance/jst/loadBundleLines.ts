import {resourceApi,type ResourceDto} from '../../../resources/api';
/** 完整读取本组合真实组成；缺页或读取期间数量变化不能当作完整BOM提交。 */
export async function loadBundleLines(bundleId:number,current:()=>boolean):Promise<ResourceDto[]|null>{
 const rows:ResourceDto[]=[],seen=new Set<number>();let total:number|null=null;
 for(let page=1;;page++){
  if(!current())return null;
  const result=await resourceApi.list('finance-bundle-lines',{fieldKey:'bundleId',fieldValue:bundleId,page,pageSize:200,showHidden:true});
  if(!current())return null;
  if(!Number.isSafeInteger(result.total)||result.total<0||!Array.isArray(result.items)||total!==null&&total!==result.total)throw new Error('组成读取不完整，请关闭后重试');total=result.total;
  for(const row of result.items){if(!Number.isSafeInteger(row.id)||row.id<=0||seen.has(row.id)||Number(row.data.bundleId)!==bundleId)throw new Error('组成读取不完整，请关闭后重试');seen.add(row.id);rows.push(row);}
  if(rows.length>total||!result.items.length&&rows.length<total)throw new Error('组成读取不完整，请关闭后重试');
  if(rows.length===total)return rows;
 }
}
