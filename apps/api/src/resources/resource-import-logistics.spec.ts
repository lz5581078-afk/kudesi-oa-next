import {sourceProductImportProfile} from '@kudesi/shared';
import type {ResourceImportProfile,ResourceImportStep} from '@kudesi/shared';
import {prepareProfileStep} from './resource-import-profile';
const step:ResourceImportStep={id:'logistics',sheet:'物流',resource:'finance-products',fields:{freight:{column:'运费',transform:'money'},handlingFee:{firstOf:[{column:'装卸费',transform:'money'},{literal:0}]},purchasePrice:{column:'采购价',transform:'money'}}};
const profile:ResourceImportProfile={id:'synthetic-logistics',label:'合成物流',steps:[step],sheets:[{name:'物流',headers:['运费','装卸费','采购价'],examples:[]}],maxRows:10};
const prepare=(row:Record<string,string>)=>prepareProfileStep(profile,step,[{name:'物流',rows:[row]}],{find:async()=>[]},{},'2026-11-04');
describe('profile金额按服务器资源字段精度转换',()=>{
 it('物流八位元与采购六位元同文件按各自合同解析',async()=>{expect((await prepare({运费:'0.12345678',装卸费:'0.00000001',采购价:'1.123456'}))[0]).toMatchObject({errors:[],input:{freight:12.345678,handlingFee:0.000001,purchasePrice:112.3456}});});
 it('第九位/不安全金额拒绝；采购输入不借物流扩大',async()=>{const row=(await prepare({运费:'0.123456789',装卸费:'999999999.12345678',采购价:'0.12345678'}))[0];expect(row.errors).toHaveLength(3);expect(row.errors.join()).toMatch(/后8位/);expect(row.errors.join()).toMatch(/安全整数/);expect(row.errors.join()).toMatch(/后6位/);});
 it('真实R05源CSV步骤直接使用同一FieldDef精度而不由客户端声明scale',async()=>{const actual=sourceProductImportProfile('raw'),products=actual.steps.find(item=>item.id==='source-products')!;const result=await prepareProfileStep(actual,products,[{name:products.sheet,rows:[{运费:'0.12345678',装卸费:'0.12345678',采购价:'1.123456'}]}],{find:async()=>[]},{},'2026-11-04');expect(result[0].input).toMatchObject({freight:12.345678,handlingFee:12.345678,purchasePrice:112.3456});expect(result[0].errors.join()).not.toMatch(/金额/);});
});
