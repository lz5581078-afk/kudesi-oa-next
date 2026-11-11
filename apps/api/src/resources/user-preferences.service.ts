import {BadRequestException,ForbiddenException,Injectable} from '@nestjs/common';
import {DataSource,EntityManager} from 'typeorm';
import {AFTER_SALES_COLUMNS_PREFERENCE,normalizeAfterSalesColumns,normalizeAfterSalesColumnWidths,type AfterSalesColumnPreference,EXPENSE_SORT_KEY,normalizeExpenseSortPreference,createChecker,resourcePermission} from '@kudesi/shared';
import {AuthUser} from '../common/auth.decorators';
import {UserPreference} from '../entities';
/** 用户偏好没有业务数据写权限，只保存当前令牌所属用户的已知展示设置。 */
@Injectable()
export class UserPreferencesService{
 constructor(private readonly ds:DataSource){}
 private check(user:AuthUser,key:string){
  const permission=key===AFTER_SALES_COLUMNS_PREFERENCE?'after-sales.workspace.view':key===EXPENSE_SORT_KEY?resourcePermission('finance-fee-items','view'):null;
  if(!permission)throw new BadRequestException('不支持的偏好类型');
  if(!createChecker(user.permissions)(permission))throw new ForbiddenException(key===EXPENSE_SORT_KEY?'没有费用档案查看权限':'没有售后工作台查看权限');
 }
 async get(user:AuthUser,key:typeof EXPENSE_SORT_KEY):Promise<{value:ReturnType<typeof normalizeExpenseSortPreference>}>;
 async get(user:AuthUser,key:string):Promise<{value:ReturnType<typeof normalizeExpenseSortPreference>|AfterSalesColumnPreference|null}>;
 async get(user:AuthUser,key:string){
  this.check(user,key);
  const row=await this.ds.manager.findOneBy(UserPreference,{companyId:user.companyId,userId:user.id,preferenceKey:key});
  if(key===AFTER_SALES_COLUMNS_PREFERENCE)return {value:row?{columns:normalizeAfterSalesColumns(row.value.columns),widths:normalizeAfterSalesColumnWidths(row.value.widths)}:null};
  return {value:normalizeExpenseSortPreference(row?.value)};
 }
 async put(user:AuthUser,key:string,value:unknown,em:EntityManager=this.ds.manager){
  this.check(user,key);
  if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>200*1024)throw new BadRequestException('顺序偏好格式不合法');
  const input=value as Record<string,unknown>;
  const fields=key===AFTER_SALES_COLUMNS_PREFERENCE?['columns','widths']:['categoryOrders','itemOrders'];
  if(Object.keys(input).some(field=>!fields.includes(field)))throw new BadRequestException('顺序偏好格式不合法');
  if(key===AFTER_SALES_COLUMNS_PREFERENCE&&!Array.isArray(input.columns))throw new BadRequestException('售后列偏好格式不合法');
  const normalized=key===AFTER_SALES_COLUMNS_PREFERENCE
   ? {columns:normalizeAfterSalesColumns(input.columns),widths:normalizeAfterSalesColumnWidths(input.widths)}
   : normalizeExpenseSortPreference(value);
  await em.upsert(UserPreference,{companyId:user.companyId,userId:user.id,preferenceKey:key,value:{...normalized}},['companyId','userId','preferenceKey']);
  return {value:normalized};
 }
}
