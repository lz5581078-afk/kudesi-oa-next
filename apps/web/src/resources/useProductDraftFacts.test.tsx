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
  it('BOM原合法六位用量预览精确，不以四位数量截断',()=>{expect(calculateDraftFacts([{kind:'component',group:'raw',id:1,qty:0.123456,loss:''}],new Map([['component:1',r({weightG:1000,totalCost:1000})]]),true)).toMatchObject({cost:123.456,weightG:123.456,complete:true});});
});

it('源采购汇总的运装只来自组件；本档运装属于下一层总成本且不混入display facts',()=>{const rows=[{kind:'component' as const,group:'raw' as const,id:1,qty:2,loss:'' as const},{kind:'component' as const,group:'package' as const,id:2,qty:3,loss:'' as const},{kind:'labor' as const,group:'labor' as const,id:3,qty:1,loss:'' as const}],records=new Map([['component:1',r({weightG:1000,purchasePrice:100,freight:10,handlingFee:5,totalCost:115})],['component:2',r({weightG:10,purchasePrice:20,freight:2,handlingFee:3,totalCost:25})],['labor:3',r({unitPrice:50})]]);const facts=calculateDraftFacts(rows,records,true);expect(facts).toMatchObject({cost:355,weightG:2030,componentFreight:26,componentHandling:19,groups:{raw:{purchaseCost:200},package:{purchaseCost:60},labor:{cost:50}}});});
it('未选择的blank只贡献0预览且complete仍false，真实ID缺失不伪造零',()=>{const rows=[{kind:'component' as const,group:'raw' as const,id:1,qty:2,loss:'' as const},{kind:'component' as const,group:'package' as const,id:null,qty:'' as const,loss:'' as const}],known=new Map([['component:1',r({weightG:1000,totalCost:115,purchasePrice:100,freight:10,handlingFee:5})]]);expect(calculateDraftFacts(rows,known,true)).toMatchObject({cost:230,weightG:2000,complete:false});expect(calculateDraftFacts([{...rows[1],id:9,qty:1}],known,true)).toMatchObject({cost:null,weightG:null,complete:false});});

it('原文件人工单价只取实际BOM descriptor，乘量精确且不伪造人力目录',()=>{const row={kind:'labor' as const,group:'labor' as const,id:null,qty:2.123456,loss:'' as const,rowId:44,importedLabor:{name:'合成存量人工',unitCost:120.25,sourceRowId:44,version:'v44'}};expect(calculateDraftFacts([row],new Map(),true)).toMatchObject({cost:255.345584,weightG:0,complete:true,groups:{labor:{cost:255.345584}}});expect(calculateDraftFacts([row],new Map(),false).cost).toBeNull();expect(calculateDraftFacts([{...row,importedLabor:{...row.importedLabor,unitCost:null}}],new Map(),true).cost).toBeNull();});
it('物流八位元参与混合预览，所有组成末尾一次舍入且不把采购价改成八位输入',()=>{
 const row={kind:'component' as const,group:'raw' as const,id:1,qty:1,loss:'' as const},record=r({weightG:1,purchasePrice:100,freight:12.345678,handlingFee:12.345678,totalCost:124.691356});
 expect(calculateDraftFacts([row],new Map([['component:1',record]]),true)).toMatchObject({cost:124.691356,componentFreight:12.345678,componentHandling:12.345678,groups:{raw:{purchaseCost:100}}});
 const tiny=r({weightG:1,purchasePrice:0,freight:0.000001,handlingFee:0,totalCost:0.000001}),halves=[{...row,qty:0.5},{...row,qty:0.5}];
 expect(calculateDraftFacts(halves,new Map([['component:1',tiny]]),true)).toMatchObject({cost:0.000001,componentFreight:0.000001});
});

it('OEM采购忽略包装运装并以六位元结算；selfmade仍包含组件物流八位事实',()=>{const row={kind:'component' as const,group:'oem_package' as const,id:1,qty:0.123456,loss:'' as const},record=r({weightG:10,purchasePrice:8,freight:12.345678,handlingFee:23.456789,totalCost:43.802467}),map=new Map([['component:1',record]]);expect(calculateDraftFacts([row],map,true,'oem')).toMatchObject({cost:0.9876,groups:{oem_package:{purchaseCost:0.9876}},componentFreight:1.524148});expect(calculateDraftFacts([row],map,true,'self').cost).toBe(5.407677);});
it('self展示采购和人工分组为六位元，financial合计仍以完整乘积保留八位元',()=>{const row={kind:'labor' as const,group:'labor' as const,id:1,qty:2.123456,loss:'' as const},facts=calculateDraftFacts([row],new Map([['labor:1',r({unitPrice:120.25})]]),true);expect(facts.cost).toBe(255.345584);expect(facts.groups.labor.purchaseCost).toBe(255.3456);});
