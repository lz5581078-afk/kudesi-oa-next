import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { DataToolsService } from './data-tools.service';
import { GridSaveService } from './grid-save.service';
describe('删除版本 HTTP DTO', () => {
  let app:INestApplication, url:string;
  const resources={remove:jest.fn().mockResolvedValue({ok:true})};
  beforeAll(async()=>{
    const mod=await Test.createTestingModule({controllers:[ResourcesController],providers:[{provide:ResourcesService,useValue:resources},{provide:DataToolsService,useValue:{}},{provide:GridSaveService,useValue:{}}]}).compile();
    app=mod.createNestApplication();
    app.use((req:{user?:unknown},_res:unknown,next:()=>void)=>{req.user={id:4,companyId:2,name:'合成',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};next();});
    app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
    await app.listen(0,'127.0.0.1');url=await app.getUrl();
  });
  afterAll(async()=>app?.close());
  beforeEach(()=>jest.clearAllMocks());
  const request=(body:unknown)=>fetch(`${url}/resources/finance-express-prices/7`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  it.each(['',123,{},'a'.repeat(17),'Z'.repeat(16),null])('拒绝畸形版本 %#',async expectedVersion=>{
    // null is deliberately not accepted as a supplied version token.
    expect((await request({reason:'合成删除',expectedVersion})).status).toBe(400);
    expect(resources.remove).not.toHaveBeenCalled();
  });
  it('新鲜格式与原无版本调用身份仅来自token',async()=>{
    expect((await request({reason:'合成删除',expectedVersion:'1234567890abcdef'})).status).toBe(200);
    expect(resources.remove).toHaveBeenLastCalledWith(expect.objectContaining({id:4,companyId:2}),'finance-express-prices',7,'合成删除','1234567890abcdef');
    expect((await request({reason:'旧调用删除'})).status).toBe(200);
    expect(resources.remove).toHaveBeenLastCalledWith(expect.objectContaining({companyId:2}),'finance-express-prices',7,'旧调用删除',undefined);
    expect((await request({reason:'合成删除',companyId:9})).status).toBe(400);
  });
});
