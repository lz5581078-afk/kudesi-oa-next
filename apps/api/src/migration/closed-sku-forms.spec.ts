import { closedSkuForm, closedSkuPayload } from './closed-sku-forms';
describe('旧SKU历史表单的受控字段',()=>{
  it('原数量、编码、人工和成本快照不重新计算，确认令牌只留在加密原文',()=>{
    const raw={payload:{specName:'原规格',lines:[{baseCodeId:10,quantity:0.001,lossRate:0.0001}],reuseInfo:{lineKeys:['10:main'],laborKeys:[],issues:[]}},inspection:{totalCost:0.000002,sources:[[10,'0.000001']],labor:[{laborItemId:5,quantity:1,source:{cost:0.000001,code:'OLD',name:'原人工',unit:'个',id:5,versionId:8}}]},result:{id:10,finalCode:'OLD-CODE',sync:[{id:10,status:'done',message:'原回查结果'}]},duplicateConfirmation:{actorId:3,confirmedAt:'2026-09-01',token:'private-source-confirmation',reason:'原确认',matches:[]}};
    const out=closedSkuForm(JSON.stringify(raw));
    expect(JSON.parse(out.legacySkuPayload)).toEqual(raw.payload);
    expect(JSON.parse(out.legacySkuInspection)).toEqual(raw.inspection);
    expect(JSON.parse(out.legacySkuResult)).toEqual({id:10,finalCode:'OLD-CODE'});
    expect(JSON.parse(out.legacySkuSync)).toEqual(raw.result.sync);
    expect(out.legacyDuplicateConfirmation).not.toContain('private-source-confirmation');
    expect(raw.duplicateConfirmation.token).toBe('private-source-confirmation');
  });
  it('新出现的未知字段或嵌套对象拒绝公开，不能把含密码/未知成本的JSON原样端出',()=>{
    expect(()=>closedSkuPayload({specName:'原规格',password:'secret'})).toThrow('未核对字段');
    expect(()=>closedSkuForm({inspection:{sources:[{apiKey:'secret'}]}})).toThrow('未核对结构');
    expect(()=>closedSkuForm({payload:{lines:[{baseCodeId:1,unknownCost:99}]}})).toThrow('未核对字段');
    expect(closedSkuForm(null)).toEqual({});
  });
});
