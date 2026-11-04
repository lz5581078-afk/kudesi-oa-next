import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {APP_GUARD} from '@nestjs/core';
import {PermissionsGuard} from '../common/permissions.guard';
import {FlowController} from './flow.controller';
import {FlowService} from './flow.service';
describe('SKU我的申请分组HTTP可选契约',()=>{
 let app:INestApplication,url:string;const flow={listRuns:jest.fn().mockResolvedValue({rows:[],total:0,page:1,pageSize:20})};
 beforeAll(async()=>{const module=await Test.createTestingModule({controllers:[FlowController],providers:[{provide:FlowService,useValue:flow},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();app=module.createNestApplication();app.use((req:{headers:Record<string,string>;user?:unknown},_res:unknown,next:()=>void)=>{if(req.headers.authorization)req.user={id:4,companyId:2,name:'合成申请人',permissions:{isCompanyAdmin:false,allow:[],deny:[]}};next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();});
 afterAll(async()=>{await app?.close();});beforeEach(()=>{jest.clearAllMocks();});
 const get=(query:string,auth=true)=>fetch(`${url}/flow/runs?view=started&templateKey=sku-batch-apply${query}`,{headers:auth?{authorization:'Bearer synthetic'}:{}});
 it('显式true才开启分组，false与省略保持默认；公司/申请人只来自登录上下文',async()=>{
  expect((await get('&groupSku=true')).status).toBe(200);expect(flow.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({id:4,companyId:2}),expect.objectContaining({groupSku:true,view:'started',templateKey:'sku-batch-apply'}));
  await get('&groupSku=false');expect(flow.listRuns.mock.calls.at(-1)?.[1]).not.toHaveProperty('groupSku');await get('');expect(flow.listRuns.mock.calls.at(-1)?.[1]).not.toHaveProperty('groupSku');
 });
 it('匿名、非法flag与外来公司/申请人参数拒绝，不扩大查询身份',async()=>{
  expect((await get('&groupSku=true',false)).status).toBe(403);expect((await get('&groupSku=1')).status).toBe(400);expect((await get('&groupSku=true&companyId=99')).status).toBe(400);expect((await get('&groupSku=true&requesterId=99')).status).toBe(400);expect(flow.listRuns).not.toHaveBeenCalled();
 });
});
