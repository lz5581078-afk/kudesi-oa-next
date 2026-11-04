import {describe,it,expect} from 'vitest';
import {normalizeExpenseSortPreference,applyExpenseSortOrder,moveExpenseIdBefore} from './expense-sort';
describe('费用个人顺序',()=>{
 it('只留正编号和合法目录键，去重后未知行稳定跟随，不修改原数组',()=>{const preference=normalizeExpenseSortPreference({categoryOrders:{root:['2',2,'1','bad'],unknown:['9']},itemOrders:{'3':[5,4,5],all:[1]},companyId:9});expect(preference).toEqual({categoryOrders:{root:['2','1']},itemOrders:{'3':['5','4'],all:['1']}});const rows=[{id:1},{id:2},{id:3}];expect(applyExpenseSortOrder(rows,['3','1']).map(row=>row.id)).toEqual([3,1,2]);expect(rows.map(row=>row.id)).toEqual([1,2,3]);expect(moveExpenseIdBefore(['1','2','3'],3,1)).toEqual(['3','1','2']);expect(moveExpenseIdBefore(['1','2'],4,1)).toEqual(['1','2']);});
});
