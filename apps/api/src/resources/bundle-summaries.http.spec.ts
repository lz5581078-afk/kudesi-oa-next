import { INestApplication, BadRequestException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PermissionsGuard } from '../common/permissions.guard';
import { BundleToolsController } from './bundle-tools.controller';
import { BundleToolsService } from './bundle-tools.service';
describe('组合摘要HTTP边界',()=>{
 let app:INestApplication,url:string;
 const summaries=jest.fn(async(_user:unknown,ids:number[])=>{if(ids.length>200||new Set(ids).size!==ids.length)throw new BadRequestException();return{rows:[]};});
 beforeAll(async()=>{
  const module=await Test.createTestingModule({controllers:[BundleToolsController],providers:[{provide:BundleToolsService,useValue:{summaries}},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();
  app=module.createNestApplication();app.use((req:{headers:Record<string,string>;user?:unknown},_res:unknown,next:()=>void)=>{if(req.headers.authorization)req.user={id:7,companyId:3,name:'合成读者',permissions:{isCompanyAdmin:false,allow:req.headers.authorization==='Bearer view'?['resource.finance-bundles.view']:[],deny:[]}};next();});
  await app.listen(0,'127.0.0.1');url=await app.getUrl();
 });
 afterAll(async()=>{await app?.close();});beforeEach(()=>summaries.mockClear());
 const get=(ids:string,auth='view')=>fetch(`${url}/finance/bundles/summaries?ids=${encodeURIComponent(ids)}&companyId=999`,{headers:auth?{authorization:`Bearer ${auth}`}:{}});
 it('仅查看权限可访问，转发token公司而非查询参数公司',async()=>{
  expect((await get('1,2')).status).toBe(200);expect(summaries).toHaveBeenCalledWith(expect.objectContaining({companyId:3,id:7}),[1,2]);
  expect((await get('1','no')).status).toBe(403);expect((await get('1','')).status).toBeGreaterThanOrEqual(400);
 });
 it('拒绝空值/负数/小数/指数/重复/超过200个ID',async()=>{
  for(const ids of ['', '-1','1.1','1e2','1,1',Array.from({length:201},(_,i)=>i+1).join(',')])expect((await get(ids)).status).toBe(400);
 });
});
