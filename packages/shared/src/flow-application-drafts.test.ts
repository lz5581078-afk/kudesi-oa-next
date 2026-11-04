import {expect,it} from 'vitest';
import {FLOW_TEMPLATES,normalizeSpecs} from './index';
it('申请草稿默认关闭，仅SKU声明真实首阶段和共享字段',()=>{
 const enabled=FLOW_TEMPLATES.filter(template=>template.applicationDraft);expect(enabled.map(template=>template.key)).toEqual(['sku-batch-apply']);expect(enabled[0].applicationDraft).toEqual({maxBatchSize:100,confirmations:[{key:'referenceSearched',label:'商品查询'}],titleField:'batchName',itemLabel:'规格',sharedFields:['scenarioId','brandId','platformIds','bundleCategoryId']});
});
it('草稿只允许暂缺主商品，普通提交与已填数量/引用结构仍严格校验',()=>{
 const raw=[{name:'草稿规格'}];expect(normalizeSpecs(raw).errors).toContain('第 1 个规格至少要有一个主商品');expect(normalizeSpecs(raw,{allowIncomplete:true}).errors).toEqual([]);expect(normalizeSpecs([{name:'有误',main:[{baseCodeId:1,qty:0.5}]}],{allowIncomplete:true}).errors.join('；')).toContain('大于 0 的整数');expect(normalizeSpecs([{name:'有误',main:[{baseCodeId:-1,qty:1}]}],{allowIncomplete:true}).errors.join('；')).toContain('商品没选');
});

it('运营需求保留原1000字，不静默截断；超限明确校验',()=>{const note='甲'.repeat(1000);expect(normalizeSpecs([{name:'草稿',note}],{allowIncomplete:true}).specs[0].note).toBe(note);expect(normalizeSpecs([{name:'草稿',note:note+'乙'}],{allowIncomplete:true}).errors.join('；')).toContain('1000');});
it('原申请入口可选六位小数数量，普通规格仍保持整数；合并不产生浮点尾差',()=>{const raw=[{name:'原入口小数',main:[{baseCodeId:1,qty:.000001},{baseCodeId:1,qty:.000002}],gift:[{baseCodeId:2,qty:.125}]}];expect(normalizeSpecs(raw).errors.length).toBeGreaterThan(0);expect(normalizeSpecs(raw,{quantityScale:6})).toMatchObject({errors:[],specs:[{main:[{baseCodeId:1,qty:.000003}],gift:[{baseCodeId:2,qty:.125}]}]});expect(normalizeSpecs([{name:'过精度',main:[{baseCodeId:1,qty:.0000001}]}],{quantityScale:6}).errors.join('；')).toContain('6 位小数');});
