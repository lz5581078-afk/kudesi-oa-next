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
  const service={statuses:jest.fn(async()=>({rows:[]})),sendTest:jest.fn(async()=>({jobId:9,status:'pending'})),testStatus:jest.fn(async()=>({jobId:9,status:'pending'}))};
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
  it('拒绝任意正文、公司身份及无效请求编号，接收人仅来自路径',async()=>{
    for(const body of [{requestId:'bad'},{requestId:randomUUID(),companyId:8},{requestId:randomUUID(),text:'任意群发正文'}])expect((await post('edit',body)).status).toBe(400);
    expect(service.sendTest).not.toHaveBeenCalled();
    const requestId=randomUUID(),result=await post('edit',{requestId});expect(result.status).toBe(201);
    expect(service.sendTest).toHaveBeenCalledWith(expect.objectContaining({id:11,companyId:7}),42,requestId);
  });
});
