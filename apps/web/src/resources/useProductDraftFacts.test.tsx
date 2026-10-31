import { describe, expect, it } from 'vitest';
import { calculateDraftFacts } from './useProductDraftFacts';
import type { ResourceDto } from './api';
const r = (data: Record<string, unknown>) => ({ data } as ResourceDto);
describe('编辑构成核算预览', () => {
  it('原料按采购计量重量、损耗只加成本、人工不计重，并保留分以下单价', () => {
    const records = new Map([['component:1', r({weightG:500,totalCost:390})], ['component:2', r({weightG:18,totalCost:0.0123})], ['labor:3',r({unitPrice:30})]]);
    const result = calculateDraftFacts([{kind:'component',group:'raw',id:1,qty:0.5,loss:10}, {kind:'component',group:'package',id:2,qty:2,loss:''}, {kind:'labor',group:'labor',id:3,qty:1,loss:''}], records, true);
    expect(result.weightG).toBe(286);
    expect(result.cost).toBe(244.5246);
    expect(result.groups.package.cost).toBe(0.0246);
  });
  it('输入中间态的非有限数量不会崩溃或伪造零成本', () => {
    expect(calculateDraftFacts([{kind:'component',group:'raw',id:1,qty:Infinity,loss:''}],new Map(),true)).toMatchObject({weightG:null,cost:null,complete:false});
  });
  it('资料或成本暂不可读时不伪造为零；无成本权限不会汇出成本', () => {
    const rows = [{kind:'component' as const,group:'raw' as const,id:1,qty:1,loss:'' as const}];
    expect(calculateDraftFacts(rows,new Map(),true)).toMatchObject({weightG:null,cost:null,complete:false});
    expect(calculateDraftFacts(rows,new Map([['component:1',r({weightG:500,totalCost:390})]]),false)).toMatchObject({weightG:500,cost:null});
  });
});
