/** 商品编码定义的组合规则；品种首字母、目录和单位来自可信目录读取。 */
export interface BaseDefinitionInput{categoryCodes:string[];categoryNames:string[];brandCode:string;brandName:string;varietyCode:string;varietyName:string;quantity:number|null;unitCode:string;unitName:string}
const segment=(value:string)=>value.trim().toUpperCase().replace(/[^A-Z0-9+*]/g,'');
const adjacent=(items:string[])=>items.filter(Boolean).filter((item,index,rows)=>!index||item!==rows[index-1]);
export function composeBaseDefinition(input:BaseDefinitionInput){const quantity=input.quantity==null?'':String(input.quantity),styleCode=[...adjacent(input.categoryCodes.map(segment)),segment(input.brandCode),segment(input.varietyCode)].filter(Boolean).join('-'),spec=quantity+input.unitName;
 const name=[...adjacent(input.categoryNames),input.brandName,input.varietyName.trim(),quantity&&input.unitName?spec:''].filter(Boolean).join('-');return{styleCode,code:[styleCode,quantity&&input.unitCode?quantity+segment(input.unitCode):''].filter(Boolean).join('-'),name,shortName:name,spec};}
export function baseDefinitionCodeErrors(value:string,label='商品编码'){const errors:string[]=[];if(!value)errors.push(label+'不能为空');else if(!/^[A-Z0-9+*]+(-[A-Z0-9+*]+)*$/.test(value))errors.push(label+'只能包含大写字母、数字、+、*和单个连接符');if(value.length>48)errors.push(label+'不能超过48个字符');return errors;}
