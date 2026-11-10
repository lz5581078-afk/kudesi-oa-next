import 'reflect-metadata';
import {SkuFinanceReviewService} from './sku-finance-review.service';
import {FlowRun,ResourceRecord} from '../entities';
import {costCompositionFacts} from '../resources/cost-components';
import type {AuthUser} from '../common/auth.decorators';
jest.mock('../resources/cost-components',()=>({costCompositionFacts:jest.fn()}));
jest.mock('./sku-brand',()=>({resolveSkuBrandId:jest.fn().mockResolvedValue(1)}));
const user:AuthUser={id:7,companyId:3,name:'财务',permissions:{isCompanyAdmin:false,allow:['product.cost.view','product.price.view'],deny:[]}};
function setup(){
 const run={id:1,companyId:3,revision:2,status:'running',templateKey:'sku-batch-apply',payload:{specs:[{name:'玉米2斤',note:'售价39元',main:[{baseCodeId:10,qty:1}],gift:[]}],platformIds:[1],scenarioId:1,_warehouse:[{lines:[],notRequired:{}}]}};
 const records=[{id:10,type:'finance-base-codes',companyId:3,status:'verified',title:'玉米',data:{productId:11,name:'玉米',code:'YM'}},{id:11,type:'finance-products',companyId:3,data:{specQty:500,specUnit:'克'}},{id:12,type:'finance-jst-skus',companyId:3,data:{goodsType:'normal',skuId:'YM',salePrice:1000}}];
 const detail={...run,activeStep:{type:'finance'},me:{canPass:true}};
 const find=jest.fn(async(entity,opts)=>{if(entity===ResourceRecord)return records.filter(r=>opts.where.type._value.includes(r.type));if(opts.select)return [];return [run];});
 const manager={find,findOneByOrFail:jest.fn().mockResolvedValue(run)},ds={manager,transaction:jest.fn(async(_isolation,fn)=>fn(manager))};
 const flow={detail:jest.fn().mockResolvedValue(detail),canSeeRun:jest.fn().mockResolvedValue(true)};
 const ai={resolveVision:jest.fn().mockResolvedValue(null)},settings={getVision:jest.fn().mockResolvedValue(null)};
 jest.mocked(costCompositionFacts).mockResolvedValue({preShipCostCents:1000,weightG:510,lines:[{unitCostCents:1000,subtotalCents:1000,weightG:510}]} as never);
 const service=new SkuFinanceReviewService(ds as never,flow as never,ai as never,settings as never),recognizeText=jest.fn().mockResolvedValue('{"issues":[]}');service.visionFactory=()=>({recognizeText} as never);
 return {service,ds,flow,detail,records,ai,find,recognizeText};
}
beforeEach(()=>{jest.clearAllMocks();});
it('当前审核人只读核对，金额来自明确售价；每次查询都限制公司',async()=>{const {service,find}=setup();const result=await service.check(user,1);expect(result.rows[0]).toMatchObject({sale:3900,mainNetG:500,weightG:510});expect(result.issues.some(i=>i.title==='名称净含量与组成不一致')).toBe(true);for(const [,opts]of find.mock.calls)expect(opts.where.companyId).toBe(3);});
it('无审核权限不读资料、不调用模型',async()=>{const {service,detail,find,ai}=setup();detail.me.canPass=false;await expect(service.check(user,1)).rejects.toThrow('财务审核人');expect(find).not.toHaveBeenCalled();expect(ai.resolveVision).not.toHaveBeenCalled();});
it('售价权限禁止读取镜像及返回价格或价格推断',async()=>{const {service,find}=setup();const result=await service.check({...user,permissions:{...user.permissions,deny:['product.price.view']}},1);expect(result.canPrice).toBe(false);expect(result.rows[0].sale).toBeNull();expect(result.rows[0].lines[0].sale).toBeNull();for(const [entity,opts]of find.mock.calls)if(entity===ResourceRecord)expect(opts.where.type._value).not.toContain('finance-jst-skus');});
it('迟到结果在审核状态变化后拒绝',async()=>{const {service,flow,detail}=setup();flow.detail.mockResolvedValueOnce(detail).mockResolvedValueOnce({...detail,revision:3});await expect(service.check(user,1)).rejects.toThrow('申请已变化');});
it('模型只产生提示，非法规格和角色被过滤，失败保留规则结果',async()=>{const {service,ai,recognizeText}=setup();ai.resolveVision.mockResolvedValue({enabled:true} as never);recognizeText.mockResolvedValue('{"issues":[{"key":"foreign","title":"修改","detail":"改数量"},{"key":"1:0","title":"品名需确认","detail":"对照名称","roles":["main","injected"]}]}');const r=await service.check(user,1);expect(r.issues.find(i=>i.title==='语义提示：品名需确认')).toMatchObject({level:'confirm',roles:['main']});expect(r.issues.some(i=>i.keys.includes('foreign'))).toBe(false);recognizeText.mockRejectedValue(new Error('secret'));const failed=await service.check(user,1);expect(failed.semanticStatus).toBe('failed');expect(failed.issues.some(i=>i.level==='difference')).toBe(true);expect(JSON.stringify(failed)).not.toContain('secret');});
it('模型等待时商品价格变化，拒绝已过期核对结果',async()=>{const {service,ai,records,recognizeText}=setup();ai.resolveVision.mockResolvedValue({enabled:true} as never);recognizeText.mockImplementation(async()=>{records[2].data.salePrice=9000;return '{"issues":[]}';});await expect(service.check(user,1)).rejects.toThrow('价格资料已变化');});
