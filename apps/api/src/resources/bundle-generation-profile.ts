import {BadRequestException,ForbiddenException} from '@nestjs/common';
import {createChecker,scaledDecimal} from '@kudesi/shared';
import type {AuthUser} from '../common/auth.decorators';
export interface BundleGenerationProfile {manualCode?:string;manualStyleCode?:string;manualName?:string;manualShortName?:string;manualPropertiesValue?:string;manualReason?:string;baseUnit?:string;weightMode?:'auto'|'manual';manualWeightG?:number;overrideReason?:string}
/** 新建与复用仅接原表单真实可写字段；价格与自动主款式仍由现服务端计算。 */
export function bundleGenerationProfile(user:AuthUser,target:BundleGenerationProfile):Record<string,unknown>{
 const out:Record<string,unknown>={};
 for(const [key,limit] of [['manualCode',120],['manualStyleCode',120],['manualName',300],['manualShortName',160],['manualPropertiesValue',255],['baseUnit',60]] as const){const raw=target[key];if(raw===undefined)continue;if(typeof raw!=='string')throw new BadRequestException('组合资料字段格式无效');const value=raw.trim();if(value.length>limit)throw new BadRequestException('组合资料字段过长');if(value)out[key]=key==='manualCode'||key==='manualStyleCode'?value.toUpperCase():value;}
 const manuals=['manualCode','manualStyleCode','manualName','manualShortName','manualPropertiesValue'].some(key=>out[key]);
 if(manuals){if(!target.manualReason?.trim())throw new BadRequestException('手改编码、款式编码、名称、简称或规格值必须写明原因');out.manualReason=target.manualReason.trim();}
 if(out.manualStyleCode&&!/^[A-Z0-9+*]+(-[A-Z0-9+*]+)*$/.test(String(out.manualStyleCode)))throw new BadRequestException('手改款式编码格式不正确');
 if(target.weightMode!==undefined){if(!['auto','manual'].includes(target.weightMode))throw new BadRequestException('重量方式无效');out.weightMode=target.weightMode;}
 if(target.weightMode==='manual'){
  if(!createChecker(user.permissions)('product.cost.edit'))throw new ForbiddenException('没有修改组合手工重量的权限');
  const grams=target.manualWeightG;if(typeof grams!=='number'||!Number.isFinite(grams)||grams<=0||grams>1_000_000_000)throw new BadRequestException('请填写有效组合总重量');
  try{scaledDecimal(grams,6);}catch{throw new BadRequestException('组合总重量最多保留六位克小数');}
  if(!target.overrideReason?.trim())throw new BadRequestException('手工重量必须说明原因');out.manualWeightG=grams;out.overrideReason=target.overrideReason.trim();
 }else if(target.manualWeightG!==undefined)throw new BadRequestException('手工重量必须选择手工重量方式');
 return out;
}
