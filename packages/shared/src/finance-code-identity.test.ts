import {describe,it,expect} from 'vitest';
import {changedFinanceCodeFields,fixedFinanceCodeFields,frozenBundleCode,retainFinanceCodeIdentity} from './finance-code-identity';
const record=(status='verified',data:Record<string,unknown>={})=>({status,data:{code:'SKU-ORIGINAL',styleCode:'STYLE-ORIGINAL',...data}});
describe('聚水潭上传事实决定编码锁定',()=>{
 it.each([record('verified'),record('reverify'),record('pending',{snapshot:'{}'}),record('pending',{jstStatus:'pending'}),record('pending',{jstStatus:'failed'}),record('pending',{recordOrigin:'external_import',_financeCodeFrozen:true})])('未上传时验证、快照、排队及旧标记均不锁码：%j',r=>{
  expect(frozenBundleCode(r)).toBe(false);for(const type of ['finance-products','finance-base-codes','finance-bundles'])expect(changedFinanceCodeFields(type,r,{code:'NEW',styleCode:'NEW-STYLE',manualCode:'NEW'})).toEqual([]);
 });
 it.each([record('pending',{jstUploadedCode:'SKU-ORIGINAL'}),record('inactive',{jstStatus:'synced'}),record('pending',{_financeCodeUploaded:true,jstStatus:'failed'})])('上传后仅锁编码，其他资料包括款式仍可维护：%j',r=>{
  for(const type of ['finance-products','finance-base-codes','finance-bundles']){
   expect(fixedFinanceCodeFields(type,r)).toEqual(['code']);expect(changedFinanceCodeFields(type,r,{code:''})).toEqual(['code']);expect(changedFinanceCodeFields(type,r,{code:'NEW'})).toEqual(['code']);expect(changedFinanceCodeFields(type,r,{styleCode:'NEW-STYLE',manualStyleCode:'NEW-STYLE',name:'新名',spec:'2KG',weightG:2,cost:3})).toEqual([]);
  }
  expect(changedFinanceCodeFields('finance-bundles',r,{manualCode:'NEW'})).toEqual(['manualCode']);
 });
 it('成功上传时记住事实，之后停用清上传编号也不解锁；未上传不沿用旧验证标记',()=>{
  const old=record('verified',{_financeCodeFrozen:true}),data:Record<string,unknown>={code:'NEW',styleCode:'NEW-STYLE'};retainFinanceCodeIdentity('finance-bundles',old,data);expect(data).toEqual({code:'NEW',styleCode:'NEW-STYLE'});
  const uploaded={...data,jstUploadedCode:'NEW'};retainFinanceCodeIdentity('finance-base-codes',old,uploaded);expect(uploaded).toHaveProperty('_financeCodeUploaded',true);
  const disabled:Record<string,unknown>={code:'WRONG',styleCode:'ANOTHER',jstUploadedCode:null,jstStatus:'not_synced'};retainFinanceCodeIdentity('finance-base-codes',record('pending',uploaded),disabled);expect(disabled).toMatchObject({code:'NEW',styleCode:'ANOTHER',_financeCodeUploaded:true});
 });
});
