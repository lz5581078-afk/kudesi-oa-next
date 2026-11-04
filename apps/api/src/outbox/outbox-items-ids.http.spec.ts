import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {APP_GUARD} from '@nestjs/core';
import {PermissionsGuard} from '../common/permissions.guard';
import {OutboxController} from './outbox.controller';
import {OutboxService} from './outbox.service';
import {PriceSyncService} from './price-sync.service';
import {CategorySyncService} from './category-sync.service';
describe('同步清单可选本页ID只读合同 HTTP',()=>{
 let app:INestApplication,url:string;const service={items:jest.fn().mockResolvedValue({total:0,rows:[]})};
 beforeAll(async()=>{const module=await Test.createTestingModule({controllers:[OutboxController],providers:[{provide:OutboxService,useValue:service},{provide:PriceSyncService,useValue:{}},{provide:CategorySyncService,useValue:{}},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();app=module.createNestApplication();app.use((req:{headers:Record<string,string>;user?:unknown},_res:unknown,next:()=>void)=>{if(req.headers.authorization)req.user={id:41,companyId:72,name:'合成人员',permissions:{isCompanyAdmin:false,allow:req.headers.authorization==='Bearer view'?['finance.jst-sync.view']:[],deny:[]}};next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();});afterAll(async()=>{await app?.close();});beforeEach(()=>jest.clearAllMocks());
 const get=(query:string,role='view')=>fetch(`${url}/finance/jst-sync/items?type=finance-bundles${query}`,{headers:role?{authorization:`Bearer ${role}`}:{}});
 it('缺查看权限不能用ids读；不接受body/query公司或其它白名单外参数',async()=>{for(const role of ['', 'none'])expect((await get('&ids=1',role)).status).toBe(403);expect((await get('&ids=1&companyId=999')).status).toBe(400);expect(service.items).not.toHaveBeenCalled();});
 it('严格正整数、最多50、去重，默认不改变旧合同',async()=>{expect((await get('&ids=3,1,3&pageSize=50')).status).toBe(200);expect(service.items).toHaveBeenLastCalledWith(expect.objectContaining({companyId:72}),expect.objectContaining({ids:[3,1],page:1,pageSize:50}));expect((await get('')).status).toBe(200);expect(service.items).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({ids:undefined,page:1,pageSize:20}));for(const value of ['', '0','-1','1.5','1e2','01','1,,2','1, 2','9007199254740992',Array.from({length:51},(_,i)=>i+1).join(',')])expect((await get('&ids='+encodeURIComponent(value))).status).toBe(400);expect(service.items).toHaveBeenCalledTimes(2);});
});
