import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {ResourcesController} from './resources.controller';
import {ResourcesService} from './resources.service';
import {DataToolsService} from './data-tools.service';
import {GridSaveService} from './grid-save.service';
describe('费用多条搜索HTTP边界',()=>{
 let app:INestApplication,url:string;const resources={list:jest.fn().mockResolvedValue({items:[],total:0,page:1,pageSize:30})};
 beforeAll(async()=>{const mod=await Test.createTestingModule({controllers:[ResourcesController],providers:[{provide:ResourcesService,useValue:resources},{provide:DataToolsService,useValue:{}},{provide:GridSaveService,useValue:{}}]}).compile();app=mod.createNestApplication();app.use((req:{user?:unknown},_res:unknown,next:()=>void)=>{req.user={id:4,companyId:2,name:'合成',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();});
 afterAll(async()=>app?.close());beforeEach(()=>jest.clearAllMocks());
 const request=(type:string,q:Record<string,string>)=>fetch(`${url}/resources/${type}?${new URLSearchParams(q)}`);
 it('费用完整多条短语超过旧100字仍保留换行，身份只来自当前令牌',async()=>{
 const terms=Array.from({length:20},(_,index)=>`合成完整短语 ${index}`).join('\n');expect(terms.length).toBeGreaterThan(100);
 expect((await request('finance-fee-items',{referenceSearch:terms})).status).toBe(200);
 expect(resources.list).toHaveBeenCalledWith(expect.objectContaining({companyId:2,id:4}),'finance-fee-items',expect.objectContaining({keyword:terms}));
 });
 it('其他资料、重复搜索、伪造公司和过大请求仍拒绝',async()=>{
 for(const [type,q] of [['finance-products',{referenceSearch:'合成'}],['finance-fee-items',{referenceSearch:'合成',keyword:'重复'}],['finance-fee-items',{referenceSearch:'合成',companyId:'9'}]] as const){expect((await request(type,q)).status).toBe(400);}
 expect((await request('finance-fee-items',{referenceSearch:'字'.repeat(20001)})).status).toBeGreaterThanOrEqual(400);expect(resources.list).not.toHaveBeenCalled();
 expect((await request('finance-products',{keyword:'字'.repeat(101)})).status).toBe(400);
 });
});
