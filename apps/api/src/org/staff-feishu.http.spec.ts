import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { PermissionsGuard } from '../common/permissions.guard';
import { StaffFeishuController } from './staff-feishu.controller';
import { StaffFeishuService } from './staff-feishu.service';

describe('人员测试通知 HTTP 边界',()=>{
  let app:INestApplication,base:string;
  const service={unbindPreview:jest.fn(async()=>({bindingCount:1})),unbind:jest.fn(async()=>({bindingCount:1})),statuses:jest.fn(async()=>({rows:[]})),sendTest:jest.fn(async()=>({jobId:9,status:'pending'})),testStatus:jest.fn(async()=>({jobId:9,status:'pending'})),resetPreview:jest.fn(async()=>({bindingCount:3})),resetBindings:jest.fn(async()=>({remainingBindings:0}))};
  beforeAll(async()=>{
    const module=await Test.createTestingModule({controllers:[StaffFeishuController],providers:[{provide:StaffFeishuService,useValue:service},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();
    app=module.createNestApplication();app.setGlobalPrefix('api');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
    // Authentication is provided by the existing JWT guard in production; this harness supplies its trusted output.
    app.use((req:any,_res:any,next:()=>void)=>{if(req.headers['x-test-role']!=='anonymous')req.user={id:11,companyId:7,name:'测试人事',permissions:{isCompanyAdmin:false,allow:req.headers['x-test-role']==='edit'?['org.staff.view','org.staff.edit']:['org.staff.view'],deny:[]}};next();});
    await app.listen(0,'127.0.0.1');base=await app.getUrl();
  });
  beforeEach(()=>jest.clearAllMocks());afterAll(async()=>{await app?.close();});
  const post=(role:string,body:unknown)=>fetch(base+'/api/org/staff-feishu/42/test-notifications',{method:'POST',headers:{'content-type':'application/json','x-test-role':role},body:JSON.stringify(body)});
  it('只读人员可看状态但不能发送；没有身份也不能发送',async()=>{
    const read=await fetch(base+'/api/org/staff-feishu',{headers:{'x-test-role':'read'}});expect(read.status).toBe(200);
    expect((await post('read',{requestId:randomUUID()})).status).toBe(403);expect((await post('anonymous',{requestId:randomUUID()})).status).toBe(403);expect(service.sendTest).not.toHaveBeenCalled();
  });
  it('接受自定义标题正文，拒绝越界身份字段及无效请求编号',async()=>{
    for(const body of [{requestId:'bad'},{requestId:randomUUID(),companyId:8},{requestId:randomUUID(),text:'未知字段'}])expect((await post('edit',body)).status).toBe(400);
    expect(service.sendTest).not.toHaveBeenCalled();
    const requestId=randomUUID(),result=await post('edit',{requestId,title:'自定义标题',body:'自定义正文'});expect(result.status).toBe(201);
    expect(service.sendTest).toHaveBeenCalledWith(expect.objectContaining({id:11,companyId:7}),42,requestId,{title:'自定义标题',body:'自定义正文'});
  });
  it('单人解绑要求查看和编辑权限，严格校验员工编号和摘要，并只使用令牌公司',async()=>{
    const unbind=(role:string,id:string,body:object)=>fetch(base+'/api/org/staff-feishu/'+id+'/unbind',{method:'POST',headers:{'content-type':'application/json','x-test-role':role},body:JSON.stringify(body)});
    for(const role of ['read','anonymous'])expect((await unbind(role,'42',{fingerprint:'a'.repeat(64)})).status).toBe(403);
    for(const [id,body] of [['bad',{fingerprint:'a'.repeat(64)}],['42',{fingerprint:'bad'}],['42',{fingerprint:'a'.repeat(64),companyId:8}]] as const)expect((await unbind('edit',id,body)).status).toBe(400);
    expect(service.unbind).not.toHaveBeenCalled();
    expect((await unbind('edit','42',{fingerprint:'a'.repeat(64)})).status).toBe(201);
    expect(service.unbind).toHaveBeenCalledWith(expect.objectContaining({id:11,companyId:7}),42,'a'.repeat(64));
    expect((await fetch(base+'/api/org/staff-feishu/42/unbind-preview',{headers:{'x-test-role':'edit'}})).status).toBe(200);
    expect(service.unbindPreview).toHaveBeenCalledWith(expect.objectContaining({id:11,companyId:7}),42);
  });
  it('批量重绑入口限制编辑权限和严格预览摘要，不接收客户端公司身份',async()=>{
    const reset=(role:string,body:object)=>fetch(base+'/api/org/staff-feishu/reset-bindings',{method:'POST',headers:{'content-type':'application/json','x-test-role':role},body:JSON.stringify(body)});
    expect((await reset('read',{fingerprint:'a'.repeat(64)})).status).toBe(403);
    expect((await reset('anonymous',{fingerprint:'a'.repeat(64)})).status).toBe(403);
    for(const body of [{fingerprint:'bad'},{fingerprint:'a'.repeat(64),companyId:8}])expect((await reset('edit',body)).status).toBe(400);
    expect(service.resetBindings).not.toHaveBeenCalled();
    expect((await reset('edit',{fingerprint:'a'.repeat(64)})).status).toBe(201);
    expect(service.resetBindings).toHaveBeenCalledWith(expect.objectContaining({companyId:7,id:11}),'a'.repeat(64));
    expect((await fetch(base+'/api/org/staff-feishu/reset-preview',{headers:{'x-test-role':'edit'}})).status).toBe(200);
    expect(service.resetPreview).toHaveBeenCalledWith(expect.objectContaining({companyId:7,id:11}));
  });
});
