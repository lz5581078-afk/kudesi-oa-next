import {expect,it} from 'vitest';
import {getResourceDef,validateResourceInput} from './resources';
it('费用挂账按选择顺序保留首节点，避免店铺默认被公司抢占；重复去重且非法值仍拒绝',()=>{
 const def=getResourceDef('finance-fee-items')!,input={name:'合成费用',direction:'expense',defaultObject:'店铺、公司、店铺'};
 const result=validateResourceInput(def,input,{status:'active'});expect(result.errors).toEqual([]);expect(result.values.defaultObject).toBe('店铺、公司');
 expect(validateResourceInput(def,{...input,defaultObject:'公司、店铺'},{status:'active'}).values.defaultObject).toBe('公司、店铺');
 expect(validateResourceInput(def,{...input,defaultObject:'不存在的节点'},{status:'active'}).errors.length).toBeGreaterThan(0);
 const ordinary={...def,fields:def.fields.map(field=>({...field,preserveSelectionOrder:false}))};
 expect(validateResourceInput(ordinary,input,{status:'active'}).values.defaultObject).toBe('公司、店铺');
});
