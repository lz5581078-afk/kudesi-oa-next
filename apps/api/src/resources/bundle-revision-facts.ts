import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import {createChecker,scaledDecimal} from '@kudesi/shared';
import {createHash} from 'crypto';
import {EntityManager} from 'typeorm';
import {AuthUser} from '../common/auth.decorators';
import {ResourceRecord} from '../entities';
import {costCompositionFacts} from './cost-components';
type Data=Record<string,unknown>;
export interface RevisionWeight{mode:'auto'|'manual';grams:number}
export interface RevisionPayload{lines:Data[];legacy:boolean;sourceToken?:string;weight?:RevisionWeight}
function revisionLines(value:unknown):Data[]{
 if(!Array.isArray(value)||value.some(line=>!line||typeof line!=='object'||Array.isArray(line)))throw new BadRequestException('每项组成必须是有效对象');return value;
}
export function readRevisionPayload(value:unknown):RevisionPayload{
 let input:unknown;try{input=typeof value==='string'?JSON.parse(value):value;}catch{throw new BadRequestException('新构成的格式不对');}
 if(Array.isArray(input))return{lines:revisionLines(input),legacy:true};
 if(!input||typeof input!=='object')throw new BadRequestException('新构成的格式不对');
 const data=input as Data;if(data.version!==1||!Array.isArray(data.lines)||typeof data.sourceToken!=='string'||!/^\w{64}$/.test(data.sourceToken))throw new BadRequestException('组成版本或来源令牌无效，请重新打开');
 let weight:RevisionWeight|undefined;
 if(data.weight!==undefined){const w=data.weight as Data;if(!w||!['auto','manual'].includes(String(w.mode))||typeof w.grams!=='number'||!Number.isFinite(w.grams)||w.grams<=0||w.grams>1_000_000_000)throw new BadRequestException('请填写有效组合总重量（kg）');try{scaledDecimal(w.grams,6);}catch{throw new BadRequestException('组合总重量最多保留六位克小数');}weight={mode:w.mode as RevisionWeight['mode'],grams:w.grams};}
 return{lines:revisionLines(data.lines),legacy:false,sourceToken:data.sourceToken,weight};
}
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Data).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,stable(v)])):value;
const INTERNAL=new Set(['updatedAtKey','signature','verifiedAt','snapshot','pendingRevisionId','verificationState','bomDefinitionKey','bomVersionId']);
/** 对应原code/definition/BOM完整业务事实；待发布标志和验证phase不使自己的草稿过期。 */
export function bundleCompositionToken(bundle:ResourceRecord,lines:ResourceRecord[]):string{
 const ordered=[...lines].sort((a,b)=>Number(a.data.sortOrder??0)-Number(b.data.sortOrder??0)||a.id-b.id);
 const data={id:bundle.id,profile:Object.fromEntries(Object.entries(bundle.data).filter(([key])=>!INTERNAL.has(key))),lines:ordered.map(row=>({id:row.id,status:row.status,data:row.data,updatedAt:row.updatedAt instanceof Date?row.updatedAt.toISOString():String(row.updatedAt??'')}))};
 return createHash('sha256').update(JSON.stringify(stable(data))).digest('hex');
}
export function assertCompositionToken(token:unknown,bundle:ResourceRecord,lines:ResourceRecord[]){if(typeof token!=='string'||token!==bundleCompositionToken(bundle,lines))throw new ConflictException('原编码或组成资料已变化，请重新打开');}
export async function normalizedRevisionWeight(em:EntityManager,user:AuthUser,bundle:ResourceRecord,lines:Data[],requested:RevisionWeight):Promise<RevisionWeight>{
 const changed=requested.mode!==String(bundle.data.weightMode||'auto')||requested.mode==='manual'&&requested.grams!==bundle.data.manualWeightG;
 if(changed&&!createChecker(user.permissions)('product.cost.edit'))throw new ForbiddenException('没有修改组合手工重量的权限');
 const grams=requested.mode==='manual'?requested.grams:(await costCompositionFacts(em,user.companyId,{...bundle.data,weightMode:'auto'},lines)).weightG;
 if(grams==null||!Number.isFinite(grams)||grams<=0||grams>1_000_000_000)throw new BadRequestException('组合重量缺失或无效，请检查组成重量');
 return{mode:requested.mode,grams};
}
export function revisionWeightPatch(payload:RevisionPayload,reason:unknown):Data{return payload.weight?{weightMode:payload.weight.mode,manualWeightG:payload.weight.mode==='manual'?payload.weight.grams:undefined,...(payload.weight.mode==='manual'?{overrideReason:String(reason||'')}:{} )}:{};}
export function writeRevisionPayload(payload:RevisionPayload,lines:Data[],weight?:RevisionWeight):string{return JSON.stringify({version:1,sourceToken:payload.sourceToken,lines,...(weight?{weight}:{})});}
