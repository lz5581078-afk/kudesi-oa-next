import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {ResourcesController} from './resources.controller';
import {ResourcesService} from './resources.service';
import {DataToolsService} from './data-tools.service';
import {GridSaveService} from './grid-save.service';
describe('原版CSV HTTP格式隔离',()=>{
 let app:INestApplication,url:string;const resources={importRows:jest.fn().mockResolvedValue({committed:true}),exportCsv:jest.fn().mockResolvedValue({csv:'合成'})};
 beforeAll(async()=>{const mod=await Test.createTestingModule({controllers:[ResourcesController],providers:[{provide:ResourcesService,useValue:resources},{provide:DataToolsService,useValue:{}},{provide:GridSaveService,useValue:{}}]}).compile();app=mod.createNestApplication();app.use((req:{user?:unknown},_res:unknown,next:()=>void)=>{req.user={id:4,companyId:2,name:'合成',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();});
 afterAll(async()=>app?.close());beforeEach(()=>jest.clearAllMocks());
 const send=(type:string,body:unknown)=>fetch(`${url}/resources/${type}/import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 it('原版上下文只对三类资料开放，身份由令牌传递；普通导入参数保持原契约',async()=>{
 const rows=[{'客户名称':'合成'}];expect((await send('finance-customers',{rows,dryRun:false,referenceArchive:true,referenceCategoryId:3})).status).toBe(201);
 expect(resources.importRows).toHaveBeenLastCalledWith(expect.objectContaining({id:4,companyId:2}),'finance-customers',rows,false,false,undefined,{categoryId:3});
 expect((await send('finance-products',{rows,dryRun:true})).status).toBe(201);expect(resources.importRows.mock.calls.at(-1)).toHaveLength(6);
 });
 it('未知格式、伪造公司和无格式上下文不能落入服务',async()=>{
 const rows=[{'客户名称':'合成'}];for(const [type,extra] of [['finance-products',{referenceArchive:true}],['finance-customers',{referenceCategoryId:3}],['finance-customers',{referenceArchive:true,companyId:9}],['finance-customers',{referenceArchive:'true'}],['finance-customers',{referenceArchive:true,referenceCategoryId:0}]] as const){expect((await send(type,{rows,dryRun:false,...extra})).status).toBe(400);}expect(resources.importRows).not.toHaveBeenCalled();
 });
 it('导出复用既有范围，不放开其他模块的原版格式',async()=>{
 expect((await fetch(`${url}/resources/finance-fee-items/export?referenceArchive=1&ids=3,4`)).status).toBe(200);expect(resources.exportCsv).toHaveBeenCalledWith(expect.objectContaining({companyId:2}),'finance-fee-items',false,expect.objectContaining({referenceArchive:true,ids:[3,4]}));
 expect((await fetch(`${url}/resources/finance-products/export?referenceArchive=1`)).status).toBe(400);expect(resources.exportCsv).toHaveBeenCalledTimes(1);
 });
});
