import {expect,it} from 'vitest';
import {getResourceDef,type FieldDef} from '@kudesi/shared';
import {displayValue} from './format';
import type {ResourceDto} from './api';
const record=(key:string,value:unknown):ResourceDto=>({id:1,type:'finance-products',title:'合成物流',status:'active',statusReason:null,data:{[key]:value},files:{},refLabels:{},secretConfigured:{},createdAt:'',updatedAt:''});
it('可信metadata声明的物流费显示八位元，普通报价和整数分结算保持原精度',()=>{
 const fields=getResourceDef('finance-products')!.fields;
 const freight=fields.find(field=>field.key==='freight')!,handling=fields.find(field=>field.key==='handlingFee')!;
 expect(freight.scale).toBe(6);expect(handling.scale).toBe(6);
 for(const field of [freight,handling]){expect(displayValue(field,record(field.key,12.345678))).toBe('¥0.12345678');expect(displayValue(field,record(field.key,0.000001))).toBe('¥0.00000001');expect(displayValue(field,record(field.key,0))).toBe('¥0');expect(displayValue(field,record(field.key,null))).toBe('');}
 expect(displayValue(freight,record('freight',0.0000001))).toBe('');expect(displayValue(freight,record('freight','未知'))).toBe('');expect(displayValue(freight,record('freight',false))).toBe('');
 const quote:FieldDef={key:'quote',label:'普通报价',type:'money',scale:4,group:'基础'};expect(displayValue(quote,record('quote',12.345678))).toBe('¥0.123457');
 const settled:FieldDef={key:'amount',label:'结算',type:'money',group:'基础'};expect(displayValue(settled,record('amount',123))).toBe('¥1.23');
});
