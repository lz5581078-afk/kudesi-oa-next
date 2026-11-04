import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {UserPreferencesController} from './user-preferences.controller';
import {UserPreferencesService} from './user-preferences.service';
describe('个人展示偏好HTTP令牌边界',()=>{
 let app:INestApplication,url:string;const service={get:jest.fn().mockResolvedValue({value:{}}),put:jest.fn().mockResolvedValue({value:{}})};
 beforeAll(async()=>{const mod=await Test.createTestingModule({controllers:[UserPreferencesController],providers:[{provide:UserPreferencesService,useValue:service}]}).compile();app=mod.createNestApplication();app.use((req:{user?:unknown},_res:unknown,next:()=>void)=>{req.user={id:4,companyId:2};next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();});afterAll(async()=>app?.close());beforeEach(()=>jest.clearAllMocks());
 it('读取和写入都只使用令牌身份，伪造本人/公司以及额外字段拒绝',async()=>{
 const endpoint=`${url}/user-preferences/finance-expense-sort-v1`;expect((await fetch(endpoint)).status).toBe(200);expect(service.get).toHaveBeenCalledWith({id:4,companyId:2},'finance-expense-sort-v1');
 const put=(body:unknown)=>fetch(endpoint,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),value={categoryOrders:{root:['2','1']},itemOrders:{}};
 expect((await put({value})).status).toBe(200);expect(service.put).toHaveBeenCalledWith({id:4,companyId:2},'finance-expense-sort-v1',value);for(const extra of [{companyId:9},{userId:8},{unexpected:true}])expect((await put({value,...extra})).status).toBe(400);expect((await put({value:[]})).status).toBe(400);expect(service.put).toHaveBeenCalledTimes(1);
 });
});
