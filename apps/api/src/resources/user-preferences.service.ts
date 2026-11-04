import {BadRequestException,ForbiddenException,Injectable} from '@nestjs/common';
import {DataSource,EntityManager} from 'typeorm';
import {EXPENSE_SORT_KEY,normalizeExpenseSortPreference,createChecker,resourcePermission} from '@kudesi/shared';
import {AuthUser} from '../common/auth.decorators';
import {UserPreference} from '../entities';
/** 用户偏好没有业务数据写权限，只保存当前令牌所属用户的已知展示设置。 */
@Injectable()
export class UserPreferencesService{
 constructor(private readonly ds:DataSource){}
 private check(user:AuthUser,key:string){if(key!==EXPENSE_SORT_KEY)throw new BadRequestException('不支持的偏好类型');if(!createChecker(user.permissions)(resourcePermission('finance-fee-items','view')))throw new ForbiddenException('没有费用档案查看权限');}
 async get(user:AuthUser,key:string){this.check(user,key);const row=await this.ds.manager.findOneBy(UserPreference,{companyId:user.companyId,userId:user.id,preferenceKey:key});return{value:normalizeExpenseSortPreference(row?.value)};}
 async put(user:AuthUser,key:string,value:unknown,em:EntityManager=this.ds.manager){this.check(user,key);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['categoryOrders','itemOrders'].includes(key))||Buffer.byteLength(JSON.stringify(value))>200*1024)throw new BadRequestException('顺序偏好格式不合法');const normalized=normalizeExpenseSortPreference(value);await em.upsert(UserPreference,{companyId:user.companyId,userId:user.id,preferenceKey:key,value:{...normalized}},['companyId','userId','preferenceKey']);return{value:normalized};}
}
