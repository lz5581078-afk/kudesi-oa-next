import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {APP_GUARD} from '@nestjs/core';
import {PermissionsGuard} from '../common/permissions.guard';
import {ResourcesController} from './resources.controller';
import {ResourcesService} from './resources.service';
import {DataToolsService} from './data-tools.service';
import {GridSaveService} from './grid-save.service';
describe('销售场景复用通用资源HTTP',()=>{
 let app:INestApplication,url:string;const create=jest.fn(async(..._args:unknown[])=>({id:91})),changeStatus=jest.fn(async(..._args:unknown[])=>({id:91,status:'inactive'}));
 beforeAll(async()=>{const module=await Test.createTestingModule({controllers:[ResourcesController],providers:[{provide:ResourcesService,useValue:{create,changeStatus}},{provide:DataToolsService,useValue:{}},{provide:GridSaveService,useValue:{}},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();app=module.createNestApplication();app.use((req:{headers:Record<string,string>;user?:unknown},_res:unknown,next:()=>void)=>{if(req.headers.authorization)req.user={id:4,companyId:2,name:'合成管理员',permissions:{isCompanyAdmin:req.headers.authorization==='Bearer admin',allow:['resource.finance-scenarios.view'],deny:[]}};next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();});
 afterAll(async()=>{await app?.close();});beforeEach(()=>jest.clearAllMocks());
 const send=(path:string,payload:unknown,auth='admin')=>fetch(url+'/resources/finance-scenarios'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+auth},body:JSON.stringify(payload)});
 it('名称入口不要求客户端生成标识，停用走原资源状态接口且公司只取token；查看者与外层伪造公司拒绝',async()=>{
  expect((await send('',{values:{name:'合成新场景'}})).status).toBe(201);expect(create).toHaveBeenCalledWith(expect.objectContaining({companyId:2,id:4}),'finance-scenarios',{name:'合成新场景'},undefined);
  expect((await send('/91/status',{status:'inactive',reason:'删除销售场景'})).status).toBe(201);expect(changeStatus).toHaveBeenCalledWith(expect.objectContaining({companyId:2,id:4}),'finance-scenarios',91,'inactive','删除销售场景');
  create.mockClear();expect((await send('',{values:{name:'无权'}},'view')).status).toBe(403);expect((await send('',{values:{name:'伪造公司'},companyId:999})).status).toBe(400);expect(create).not.toHaveBeenCalled();
 });
});
