import {getResourceDef} from '@kudesi/shared';
import type {ResourceDto} from './api';
import {unitOptionLabel} from './unitOptions';

/** 生产组成选项沿原名称/品牌/名称规格口径，不混入档案全名的生产编号。 */
export function productionProductLabel(row:ResourceDto):string{
 const data=row.data,field=getResourceDef('finance-products')!.fields.find(field=>field.key==='specUnit')!,code=String(data.specUnit??'');
 const unit=unitOptionLabel(field,data,code)||field.options?.find(option=>option.value===code)?.label||code;
 const name=String(data.name||row.title||'未命名商品').trim(),brand=typeof data.brandId==='number'?String(row.refLabels.brandId||'').trim():'';
 return [name,brand,[String(data.specQty??'').trim(),unit].filter(Boolean).join('')].filter(Boolean).join(' · ');
}
