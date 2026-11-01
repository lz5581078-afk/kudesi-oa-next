import { ExecutionContext,ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { allGrantableKeys } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { PermissionsGuard } from '../common/permissions.guard';
import { CostVersionController } from './cost-version.controller';

const guard=new PermissionsGuard(new Reflector());
const user=(allow:string[],isCompanyAdmin=false):AuthUser=>({id:1,companyId:1,name:'测试',permissions:{isCompanyAdmin,allow,deny:[]}});
const allowed=(method:keyof CostVersionController,who:AuthUser)=>{
  const context={getHandler:()=>CostVersionController.prototype[method],getClass:()=>CostVersionController,switchToHttp:()=>({getRequest:()=>({user:who,params:{}})})} as unknown as ExecutionContext;
  try{return guard.canActivate(context);}catch(e){if(e instanceof ForbiddenException)return false;throw e;}
};
describe('成本版本权限',()=>{
  const reads=['skuOptions','effective','preview','sources','recalculatePreview','export'] as const,writes=['register','copy','activate','recalculate','clear'] as const;
  it('页面权限不等于成本查看或维护权限',()=>{
    const pageOnly=user(['finance.cost-table.view','resource.finance-cost-versions.*']);
    for(const method of [...reads,...writes])expect(allowed(method,pageOnly)).toBe(false);
  });
  it('只读成本人员不能通过动作接口启用、重算、复制或清空',()=>{
    const viewer=user(['finance.cost-table.view','resource.finance-cost-versions.view','product.cost.view']);
    for(const method of reads)expect(allowed(method,viewer)).toBe(true);
    for(const method of writes)expect(allowed(method,viewer)).toBe(false);
  });
  it('所有读写路由都声明权限；资源权限能在现有权限面板授予',()=>{
    for(const method of [...reads,...writes])expect(allowed(method,user([],true))).toBe(true);
    const keys=allGrantableKeys();for(const action of ['view','create','edit','delete','import','export'])expect(keys.has(`resource.finance-cost-versions.${action}`)).toBe(true);
  });
});
