import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from '../common/permissions.guard';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { DataToolsService } from './data-tools.service';
import { GridSaveService } from './grid-save.service';

describe('专属编辑 HTTP 权限和身份边界',()=>{
 let app:INestApplication,url:string;
 const resources={confirmBaseProfile:jest.fn().mockResolvedValue({id:1})};
 beforeAll(async()=>{
  const module=await Test.createTestingModule({controllers:[ResourcesController],providers:[{provide:ResourcesService,useValue:resources},{provide:DataToolsService,useValue:{}},{provide:GridSaveService,useValue:{}},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();
  app=module.createNestApplication();
  app.use((req:{headers:Record<string,string>;user?:unknown},_res:unknown,next:()=>void)=>{if(req.headers.authorization)req.user={id:4,companyId:2,name:'员工',permissions:{isCompanyAdmin:false,allow:[req.headers.authorization==='Bearer edit'?'resource.finance-base-codes.edit':'resource.finance-base-codes.view'],deny:[]}};next();});
  app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();
 });
 afterAll(async()=>{await app?.close();});beforeEach(()=>jest.clearAllMocks());
 const send=(body:unknown,auth='edit',type='finance-base-codes')=>fetch(`${url}/resources/${type}/1/profile`,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${auth}`}:{})},body:JSON.stringify(body)});
 it('未登录和只有查看权限都拒绝，不能跨资料类型复用编辑权限',async()=>{expect((await send({values:{}},'')).status).toBe(403);expect((await send({values:{}},'view')).status).toBe(403);expect((await send({values:{}},'edit','finance-bundles')).status).toBe(403);expect(resources.confirmBaseProfile).not.toHaveBeenCalled();});
 it('公司操作人只来自登录身份，请求顶层额外字段被拒绝',async()=>{expect((await send({values:{name:'测试'},companyId:99})).status).toBe(400);expect(resources.confirmBaseProfile).not.toHaveBeenCalled();expect((await send({values:{name:'测试'}})).status).toBe(201);expect(resources.confirmBaseProfile).toHaveBeenCalledWith(expect.objectContaining({id:4,companyId:2}),'finance-base-codes',1,{name:'测试'});});
});
