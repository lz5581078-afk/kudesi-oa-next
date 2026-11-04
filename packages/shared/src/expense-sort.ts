/** 费用目录/资料的个人顺序；只保存资料编号，不改变公司共享分类或业务记录。 */
export interface ExpenseSortPreference {categoryOrders:Record<string,string[]>;itemOrders:Record<string,string[]>}
export const EXPENSE_SORT_KEY='finance-expense-sort-v1';
export function normalizeExpenseSortPreference(input:unknown):ExpenseSortPreference{
 const output:ExpenseSortPreference={categoryOrders:{},itemOrders:{}};
 if(!input||typeof input!=='object'||Array.isArray(input))return output;
 for(const section of ['categoryOrders','itemOrders'] as const){const source=(input as Record<string,unknown>)[section];if(!source||typeof source!=='object'||Array.isArray(source))continue;
 for(const [key,values] of Object.entries(source).slice(0,2000)){if(!/^(?:root|all|[1-9][0-9]*)$/.test(key)||!Array.isArray(values))continue;const ids=[...new Set(values.filter(value=>typeof value==='string'||typeof value==='number').map(String).filter(value=>/^[1-9][0-9]*$/.test(value)))].slice(0,2000);if(ids.length)output[section][key]=ids;}}
 return output;
}
export function applyExpenseSortOrder<T extends {id:string|number}>(rows:T[],order:readonly string[]|undefined):T[]{if(!order?.length)return rows;const positions=new Map(order.map((id,index)=>[String(id),index]));return rows.map((row,index)=>({row,index})).sort((a,b)=>(positions.get(String(a.row.id))??Number.MAX_SAFE_INTEGER)-(positions.get(String(b.row.id))??Number.MAX_SAFE_INTEGER)||a.index-b.index).map(item=>item.row);}
export function moveExpenseIdBefore(ids:readonly string[],sourceId:string|number,targetId:string|number):string[]{const source=String(sourceId),target=String(targetId);if(source===target||!ids.includes(source)||!ids.includes(target))return [...ids];const next=ids.filter(id=>id!==source);next.splice(next.indexOf(target),0,source);return next;}
