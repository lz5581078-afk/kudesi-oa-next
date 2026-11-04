import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {APP_GUARD} from '@nestjs/core';
import {PermissionsGuard} from '../common/permissions.guard';
import {FilesService} from '../integrations/files.service';
import {FinanceDocumentsController} from './finance-documents.controller';
import {FinanceDocumentsService} from './finance-documents.service';
import {FinanceVoucherHintsService} from './finance-voucher-hints.service';
describe('财务挂账明细身份与名称HTTP白名单',()=>{
  let app:INestApplication,url:string;
  const docs={updateDraft:jest.fn().mockResolvedValue({id:9})};
  beforeAll(async()=>{
    const module=await Test.createTestingModule({controllers:[FinanceDocumentsController],providers:[{provide:FinanceDocumentsService,useValue:docs},{provide:FilesService,useValue:{}},{provide:FinanceVoucherHintsService,useValue:{}},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile();app=module.createNestApplication();
    app.use((req:{user?:unknown},_res:unknown,next:()=>void)=>{req.user={id:4,companyId:2,name:'合成核对员',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();
  });
  beforeEach(()=>jest.clearAllMocks());afterAll(async()=>{await app?.close();});
  const put=(line:Record<string,unknown>,extra={})=>fetch(url+'/finance/docs/9',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({type:'expense',date:'2026-11-03',lines:[{feeItemId:7,qty:1,unitPriceCents:1000,...line}],...extra})});
  it('正整数行ID、显式重选和512字名称完整交业务服务，身份仍只取认证上下文',async()=>{
    const relatedName='字'.repeat(512);expect((await put({id:71,relatedNode:'不固定',relatedName,refreshRelatedName:true})).status).toBe(200);expect(docs.updateDraft).toHaveBeenCalledWith(expect.objectContaining({id:4,companyId:2}),9,expect.objectContaining({lines:[expect.objectContaining({id:71,relatedName,refreshRelatedName:true})]}),undefined);
  });
  it('超长名称、非法行ID和非布尔刷新标记在DTO拦截，不执行写入',async()=>{
    for(const line of [{relatedName:'字'.repeat(513)},{id:0},{id:1.5},{refreshRelatedName:'true'}])expect((await put(line)).status).toBe(400);expect(docs.updateDraft).not.toHaveBeenCalled();
  });
  it('行内或单据附带公司/操作人等额外身份字段仍拒绝',async()=>{
    expect((await put({id:71,companyId:8})).status).toBe(400);expect((await put({id:71},{companyId:8})).status).toBe(400);expect(docs.updateDraft).not.toHaveBeenCalled();
  });
  it('项目文字512字与重选标记可保存，客户端不能伪造专用名称编码快照',async()=>{
    expect((await put({itemName:'字'.repeat(512),refreshItemName:true})).status).toBe(200);
    expect(docs.updateDraft).toHaveBeenCalledWith(expect.anything(),9,expect.objectContaining({lines:[expect.objectContaining({refreshItemName:true,itemName:'字'.repeat(512)})]}),undefined);
    jest.clearAllMocks();
    for(const line of [{itemName:'字'.repeat(513)},{refreshItemName:'true'},{productNameSnapshot:'伪造'},{feeItemNameSnapshot:'伪造'},{itemCodeSnapshot:'伪造'}])expect((await put(line)).status).toBe(400);
    expect(docs.updateDraft).not.toHaveBeenCalled();
  });

});
