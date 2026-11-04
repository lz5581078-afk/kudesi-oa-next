/** 24号往来/费用CSV列；仅专属入口启用，通用资料导入导出保持原契约。 */
export interface ArchiveCsvColumn {key:string;label:string}
export interface ArchiveCsvConfig {categoryField:'categoryId'|'categoryIds';categoryType:string;columns:readonly ArchiveCsvColumn[]}
const columns=(values:readonly (readonly [string,string])[]):ArchiveCsvColumn[]=>values.map(([key,label])=>({key,label}));
const configs:Record<string,ArchiveCsvConfig>={
 'finance-suppliers':{categoryField:'categoryIds',categoryType:'finance-supplier-categories',columns:columns([
 ['categoryIds','供应商分类'],['code','供应商编号'],['name','供应商名称'],['shortName','供应商简称'],['shortCode','简称编号'],['contact','联系人'],['phone','联系电话'],['bankAccountName','账户名称'],['bank','开户行'],['bankAccountNo','银行账号'],['note','备注'],['$status','状态'],['$statusReason','停用原因']])},
 'finance-customers':{categoryField:'categoryIds',categoryType:'finance-customer-categories',columns:columns([
 ['categoryIds','客户分类'],['code','客户编号'],['name','客户名称'],['contact','联系人'],['phone','联系电话'],['note','备注'],['$status','状态'],['$statusReason','停用原因']])},
 'finance-fee-items':{categoryField:'categoryId',categoryType:'finance-fee-categories',columns:columns([
 ['categoryId','费用分类'],['code','费用类型编号'],['name','费用类型名称'],['accountingSubject','会计/核算科目'],['direction','收支方向'],['platform','适用平台'],['isCommon','是否常用'],['requiredObject','费用单必须挂归属对象'],['needFlow','是否走流程'],['relationRequirement','挂账节点说明'],['note','费用备注'],['$status','状态'],['$statusReason','停用原因']])},
};
export const referenceArchiveCsv=(type:string):ArchiveCsvConfig|undefined=>configs[type];
export interface ArchiveCsvImportContext {categoryId?:number;paths?:Map<number,string>}
