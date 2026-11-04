import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {APP_GUARD} from '@nestjs/core';
import {PermissionsGuard} from '../common/permissions.guard';
import {ResourcesController} from './resources.controller';
import {ResourcesService} from './resources.service';
import {DataToolsService} from './data-tools.service';
import {GridSaveService} from './grid-save.service';
import {randomUUID} from 'crypto';
describe('供应商复制整组HTTP契约',()=>{
 let app:INestApplication,url:string;
 const resources={saveForm:jest.fn().mockResolvedValue({id:91})};
 beforeAll(async()=>{const module=await Test.createTestingModule({controllers:[ResourcesController],providers:[{provide:ResourcesService,useValue:resources},{provide:DataToolsService,useValue:{}},{provide:GridSaveService,useValue:{}},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();app=module.createNestApplication();app.use((req:{headers:Record<string,string>;user?:unknown},_res:unknown,next:()=>void)=>{if(req.headers.authorization)req.user={id:4,companyId:2,name:'合成复制员',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();});
 afterAll(async()=>{await app?.close();});beforeEach(()=>{jest.clearAllMocks();});
 const body=()=>({requestKey:randomUUID(),values:{name:'合成副本',paymentQr:[]},collections:[],copySource:{id:8,version:'source-version',files:{paymentQr:[13]}}});
 const send=(payload:unknown,auth=true)=>fetch(`${url}/resources/finance-suppliers/save-form`,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer synthetic'}:{})},body:JSON.stringify(payload)});
 it('copySource通过严格嵌套DTO，身份只取登录上下文；匿名和额外公司/敏感标记拒绝',async()=>{
  const input=body();expect((await send(input)).status).toBe(201);expect(resources.saveForm).toHaveBeenCalledWith(expect.objectContaining({companyId:2,id:4}),'finance-suppliers',expect.objectContaining(input));
  resources.saveForm.mockClear();expect((await send(input,false)).status).toBe(403);expect((await send({...input,copySource:{...input.copySource,companyId:99}})).status).toBe(400);expect((await send({...input,copySource:{...input.copySource,sensitive:['bankAccountNo']}})).status).toBe(400);expect((await send({...input,copySource:{...input.copySource,id:'8'}})).status).toBe(400);expect(resources.saveForm).not.toHaveBeenCalled();
 });
});
