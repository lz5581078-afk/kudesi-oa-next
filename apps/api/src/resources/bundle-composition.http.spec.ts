import {INestApplication,ValidationPipe} from '@nestjs/common';
import {APP_GUARD} from '@nestjs/core';
import {Test} from '@nestjs/testing';
import {PermissionsGuard} from '../common/permissions.guard';
import {BundleToolsController} from './bundle-tools.controller';
import {BundleToolsService} from './bundle-tools.service';
describe('组成读取与提交HTTP契约',()=>{
 let app:INestApplication,url:string;
 const createRevision=jest.fn(async()=>({id:99})),composition=jest.fn(async()=>({sourceToken:'a'.repeat(64)}));
 beforeAll(async()=>{const module=await Test.createTestingModule({controllers:[BundleToolsController],providers:[{provide:BundleToolsService,useValue:{createRevision,composition}},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();app=module.createNestApplication();app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));app.use((req:{headers:Record<string,string>;user?:unknown},_res:unknown,next:()=>void)=>{if(req.headers.authorization)req.user={id:7,companyId:3,name:'合成申请人',permissions:{isCompanyAdmin:false,allow:req.headers.authorization==='Bearer edit'?['resource.finance-bundles.edit','resource.finance-bundles.view']:['resource.finance-bundles.view'],deny:[]}};next();});await app.listen(0,'127.0.0.1');url=await app.getUrl();});
 afterAll(async()=>{await app?.close();});beforeEach(()=>{createRevision.mockClear();composition.mockClear();});
 const post=(body:unknown,auth='edit')=>fetch(url+'/finance/bundles/7/revisions?companyId=999',{method:'POST',headers:{authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const body=()=>({reason:'合成实际材料调整',sourceToken:'a'.repeat(64),weight:{mode:'manual',grams:1234.567891},lines:[{role:'main',baseCodeId:11,qty:1,includeInJst:true},...Array.from({length:199},(_,i)=>({role:'package',productId:i+200,qty:1.123456,includeInJst:false})),{role:'labor',laborId:901,qty:1.654321}]});
 it('201项含直接档案/人工与精确重量完整传入，始终用token公司',async()=>{const input=body();expect((await post(input)).status).toBe(200);const call=createRevision.mock.calls[0] as unknown[];expect(call[0]).toMatchObject({companyId:3,id:7});expect(call[3]).toHaveLength(201);expect((call[3] as unknown[])[199]).toMatchObject({productId:398,qty:1.123456});expect((call[3] as unknown[])[200]).toMatchObject({laborId:901,qty:1.654321});expect(call[4]).toMatchObject({sourceToken:input.sourceToken,weight:{mode:'manual',grams:1234.567891}});});
 it('读取仅需view，提交需edit；缺来源token/未知价格字段/超过300项拒绝',async()=>{expect((await fetch(url+'/finance/bundles/7/composition',{headers:{authorization:'Bearer view'}})).status).toBe(200);expect(composition).toHaveBeenCalledWith(expect.objectContaining({companyId:3}),7);expect((await post(body(),'view')).status).toBe(403);const input=body();expect((await post({...input,sourceToken:undefined})).status).toBe(400);expect((await post({...input,lines:[{role:'main',productId:20,qty:1,price:1}]})).status).toBe(400);expect((await post({...input,lines:Array.from({length:301},()=>({role:'main',baseCodeId:11,qty:1}))})).status).toBe(400);expect(createRevision).not.toHaveBeenCalled();});
});
