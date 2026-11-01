import { isDeepStrictEqual } from 'node:util';
import { getResourceDef,normalizePhone,validateResourceInput } from '@kudesi/shared';
import type { DataSource,EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import type { ResourcesService } from '../resources/resources.service';
import { ResourceRecord } from '../entities';
import { withReadonlyAppend } from '../resources/append-only';
import { sourceRowHash } from './source-rows';
import type { LegacyRecord } from './protocol';

const TYPE='phone-registration-history';
const FIELDS:Record<string,string>={certifiedName:'phone_owner_name',plan:'package_name',externalUser:'external_user_name',deviceType:'phone_device_type',forwardApp:'has_forwarding_app',forwardAppName:'forwarding_app_name',rechargeDay:'recharge_day',feeCycle:'fee_cycle',originalRemark:'remark'};
const ALLOWED_RAW=new Set(['id',...Object.values(FIELDS)]);
const ALLOWED_DATA=new Set(['certifiedName','plan','externalUser','deviceType','forwardApp','forwardAppName','rechargeDay','feeCycle','note']);
interface Original {record:LegacyRecord;raw:Record<string,unknown>;data:Record<string,unknown>;parentId?:number}
/** Only the reviewed differences may be represented by this compact history.
 * Compare every raw column and every converted field, including sensitive and
 * secret fields; unknown differences block rather than disappear in a merge. */
export async function importPhoneRegistrations(ctx:{em:EntityManager;resources:ResourcesService;user:AuthUser;sourceCompanyId:number;parentId:number},originals:Original[]){
  const fail=(why:string)=>Error('旧号码登记核对未完成：'+why);
  const {em,user}=ctx;
  if(!em.queryRunner?.isTransactionActive||em.queryRunner.data.legacyImport!==true||originals.length<2)throw fail('缺少同号组及迁移事务');
  if(new Set(originals.map(o=>o.record.id)).size!==originals.length)throw fail('来源身份重复');
  const parent=await em.findOneBy(ResourceRecord,{id:ctx.parentId,companyId:user.companyId,type:'phones'});
  if(!parent)throw fail('本公司号码档案不存在');
  const first=originals[0];
  for(const o of originals){
    const ownParent=o.parentId==null?parent:await em.findOneBy(ResourceRecord,{id:o.parentId,companyId:user.companyId,type:'phones'});
    if(!ownParent||ownParent.data.number!==parent.data.number)throw fail('独立登记与同号组不一致');
    if(String(o.raw.company_id)!==String(ctx.sourceCompanyId)||String(o.raw.id)!==o.record.id||o.record.type!=='phones'||o.record.files?.length||o.record.status!==first.record.status||!isDeepStrictEqual(o.record.archive,first.record.archive))throw fail('公司、身份、状态或归档/附件存在未兼容差异');
    if(typeof o.raw.number!=='string'||normalizePhone(o.raw.number)!==parent.data.number||normalizePhone(String(o.data.number??''))!==parent.data.number)throw fail('原号码与主档案不一致');
    if(o.raw.has_forwarding_app!=null&&![0,1,'0','1'].includes(o.raw.has_forwarding_app as string|number))throw fail('原转发标记尚未兼容');
    for(const key of new Set([...Object.keys(first.raw),...Object.keys(o.raw)]))if(!ALLOWED_RAW.has(key)&&!isDeepStrictEqual(first.raw[key],o.raw[key]))throw fail('其他原始字段仍有差异');
    for(const key of new Set([...Object.keys(first.data),...Object.keys(o.data)]))if(!ALLOWED_DATA.has(key)&&!isDeepStrictEqual(first.data[key],o.data[key]))throw fail('其他转换字段仍有差异');
  }
  const results:Array<{sourceId:string;id:number;reused:boolean}>=[];
  for(const o of originals){
    const values:Record<string,unknown>={phoneId:o.parentId??parent.id,sourceId:o.record.id,sourceStatus:o.raw.status??null};
    for(const [field,column]of Object.entries(FIELDS)){
      const value=o.raw[column];
      if(value!=null&&typeof value!=='string'&&!(field==='forwardApp'&&[0,1].includes(Number(value))))throw fail('原登记字段类型尚未兼容');
      values[field]=value==null?null:String(value);
    }
    const def=getResourceDef(TYPE)!;
    if(validateResourceInput(def,values,{status:'recorded'}).errors.length||def.fields.some(f=>typeof values[f.key]==='string'&&(values[f.key] as string).length>(f.maxLength??200)))throw fail('原值超过字段范围，未截断');
    const proof=sourceRowHash(o.raw);
    let row=await ctx.resources.findByUnique(em,user.companyId,TYPE,o.record.id);const reused=Boolean(row);
    if(row){
      if(row.data._legacySourceHash!==proof||Object.entries(values).some(([k,v])=>!isDeepStrictEqual(row!.data[k],v)))throw fail('已迁登记有变化，禁止覆盖');
    }else{
      row=await withReadonlyAppend(em,user.companyId,TYPE,()=>ctx.resources.createRecord(em,user,TYPE,values,'保留同号原登记'));
      // Text normalization must not remove original whitespace or null/empty
      // distinctions. Only these explicitly checked readonly fields are copied.
      row.data={...row.data,...values,_legacySourceHash:proof};await em.save(ResourceRecord,row);
    }
    const bound=Object.create(em.connection) as DataSource;Object.defineProperty(bound,'manager',{value:em});
    const viewer=Object.create(ctx.resources) as ResourcesService;Object.defineProperty(viewer,'dataSource',{value:bound});
    const dto=await viewer.get(user,TYPE,row.id);
    if('_legacySourceHash' in dto.data||Object.entries(values).some(([k,v])=>!isDeepStrictEqual(dto.data[k],v)))throw fail('原登记页面读取不一致');
    results.push({sourceId:o.record.id,id:row.id,reused});
  }
  return results;
}
