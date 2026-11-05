import {describe,it,expect} from 'vitest';
import {changedFinanceCodeFields,fixedFinanceCodeFields,frozenBundleCode,retainFinanceCodeIdentity} from './finance-code-identity';
const record=(status='verified',data:Record<string,unknown>={})=>({status,data:{code:'SKU-ORIGINAL',styleCode:'STYLE-ORIGINAL',...data}});
describe('商品编码是持久身份',()=>{
 it('商品和基础编码保存后不可清空/重编，资料字段正常变更',()=>{
  for(const type of ['finance-products','finance-base-codes']){expect(changedFinanceCodeFields(type,record(),{code:''})).toEqual(['code']);expect(changedFinanceCodeFields(type,record(),{code:'NEW'})).toEqual(['code']);expect(changedFinanceCodeFields(type,record(),{name:'new name',weightG:2,cost:3})).toEqual([]);}
  expect(fixedFinanceCodeFields('finance-base-codes',record())).toEqual(['code','styleCode']);expect(fixedFinanceCodeFields('finance-products',null)).toEqual([]);
 });
 it.each([record('verified'),record('reverify'),record('inactive',{verificationState:'verified'}),record('pending',{snapshot:'{}'}),record('pending',{jstUploadedCode:'SKU-ORIGINAL'}),record('pending',{recordOrigin:'external_import'})])('已发布、已上传或旧导入组合不随资料变更改码：%j',r=>{
  expect(frozenBundleCode(r)).toBe(true);const data:Record<string,unknown>={code:'WRONG',styleCode:'WRONG',name:'new',cost:4};retainFinanceCodeIdentity('finance-bundles',r,data);expect(data).toMatchObject({code:'SKU-ORIGINAL',styleCode:'STYLE-ORIGINAL',name:'new',cost:4,_financeCodeFrozen:true});
 });
 it('草稿构建仍可生成，验证后的固化标记在退回待验证时保留',()=>{
  expect(frozenBundleCode(record('pending'))).toBe(false);expect(frozenBundleCode(record('verified',{code:'ZH-待配置-123'}))).toBe(false);const old=record('pending',{_financeCodeFrozen:true});expect(frozenBundleCode(old)).toBe(true);expect(changedFinanceCodeFields('finance-bundles',old,{manualCode:'NEW'})).toEqual(['manualCode']);expect(changedFinanceCodeFields('finance-bundles',old,{manualCode:''})).toEqual([]);
 });
});
