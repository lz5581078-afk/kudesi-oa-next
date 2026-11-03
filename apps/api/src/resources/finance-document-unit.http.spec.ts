import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {APP_GUARD} from '@nestjs/core';
import {PermissionsGuard} from '../common/permissions.guard';
import {FilesService} from '../integrations/files.service';
import {FinanceDocumentsController} from './finance-documents.controller';
import {FinanceDocumentsService} from './finance-documents.service';
import {FinanceVoucherHintsService} from './finance-voucher-hints.service';
describe('原单据40字自由单位HTTP边界',()=>{
  let app:INestApplication,url:string;
  const docs={createDraft:jest.fn().mockResolvedValue({id:1}),inventoryLedger:jest.fn().mockResolvedValue({rows:[]})};
  beforeAll(async()=>{
    const module=await Test.createTestingModule({controllers:[FinanceDocumentsController],providers:[{provide:FinanceDocumentsService,useValue:docs},{provide:FilesService,useValue:{}},{provide:FinanceVoucherHintsService,useValue:{}},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();
    app=module.createNestApplication();app.use((req:{user?:unknown},_res:unknown,next:()=>void)=>{req.user={id:4,companyId:2,name:'合成核对员',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};next();});
    app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();
  });
  beforeEach(()=>jest.clearAllMocks());afterAll(async()=>{await app?.close();});
  const post=(unit:string)=>fetch(url+'/finance/docs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'purchase-in',date:'2026-11-03',warehouseId:2,partyId:1,lines:[{productId:3,unit,qty:1,unitPriceCents:100}]})});
  it('40字单位完整交给业务服务，登录公司和操作人来自上下文',async()=>{
    const unit='计'.repeat(40);expect((await post(unit)).status).toBe(201);expect(docs.createDraft).toHaveBeenCalledWith(expect.objectContaining({id:4,companyId:2}),expect.objectContaining({lines:[expect.objectContaining({unit})]}),{memo:undefined});
  });
  it('41字在DTO拒绝，不执行草稿写入',async()=>{expect((await post('计'.repeat(41))).status).toBe(400);expect(docs.createDraft).not.toHaveBeenCalled();});
  it('流水单位筛选保留40字或明确空单位，41字拒绝，不从查询参数取身份',async()=>{
    const get=(unit:string)=>fetch(url+'/finance/inventory-ledger?'+new URLSearchParams({productId:'3',warehouseId:'2',unit}));
    const unit='计'.repeat(40);expect((await get(unit)).status).toBe(200);expect(docs.inventoryLedger).toHaveBeenLastCalledWith(expect.objectContaining({id:4,companyId:2}),expect.objectContaining({productId:3,warehouseId:2,unit}));
    expect((await get('')).status).toBe(200);expect(docs.inventoryLedger).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({unit:''}));
    const before=docs.inventoryLedger.mock.calls.length;expect((await get('计'.repeat(41))).status).toBe(400);expect(docs.inventoryLedger).toHaveBeenCalledTimes(before);
  });

});
