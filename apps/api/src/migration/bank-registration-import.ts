import { getResourceDef,validateResourceInput,yuanToPreciseCents } from '@kudesi/shared';
import type { DataSource,EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';
import type { CryptoService } from '../common/crypto.service';
import type { AuthUser } from '../common/auth.decorators';
import type { ResourcesService } from '../resources/resources.service';
import { withReadonlyAppend } from '../resources/append-only';
import { sourceRowHash } from './source-rows';
import { legacyWallTime } from './legacy-time';

const TYPE='bank-account-history';
const FIELDS=new Set(['kind','accountName','bank','accountNo','ownerName','licenseId','storeId','keeperUserId','reservedPhoneNumber','reservedPhoneHolder','phoneId','customerNo','openingArchiveLocationId','balance','reconcileCycle','reconcileDay','abnormalReason','note']);
/** Retain every original registration below its corresponding account. Original
 * balances here are descriptive snapshots, never additional opening balances. */
export async function importBankRegistration(ctx:{em:EntityManager;resources:ResourcesService;crypto:CryptoService;user:AuthUser;sourceCompanyId:number;parentId:number;lookup(type:string,id:unknown):number|undefined},sourceId:string,raw:Record<string,any>,data:Record<string,unknown>,hasFiles:boolean){
  const fail=(detail='')=>Error('旧银行登记核对未完成'+(detail?'：'+detail:''));
  const {em,user}=ctx;
  if(!em.queryRunner?.isTransactionActive||em.queryRunner.data.legacyImport!==true||String(raw.company_id)!==String(ctx.sourceCompanyId)||String(raw.id)!==sourceId||Object.keys(data).some(k=>!FIELDS.has(k)))throw fail();
  if(hasFiles||[1,2,3,4].some(i=>String(raw[`public_account_attachment_${i}_data_url`]??'').trim()))throw fail('开户附件须单独核对，未忽略');
  legacyWallTime(raw.created_at,true);
  const parent=await em.findOneBy(ResourceRecord,{id:ctx.parentId,companyId:user.companyId,type:'bank-accounts'});
  const unique=typeof data.accountNo==='string'?await ctx.resources.findByUnique(em,user.companyId,'bank-accounts',data.accountNo,ctx.parentId):null;
  if(!parent||unique?.id!==parent.id||parent.data.accountName!==data.accountName||parent.data.bank!==data.bank||raw.current_balance==null||data.kind!==raw.account_kind)throw fail('原账户身份或原余额缺失');
  const balance=yuanToPreciseCents(String(raw.current_balance),0);
  if(data.balance!==balance||parent.data.balance!==balance)throw fail('同一账户原余额不一致，不重复相加或猜测');
  for(const [field,column,type] of [['keeperUserId','keeper_employee_id','user'],['licenseId','license_id','licenses'],['storeId','store_id','stores'],['phoneId','phone_number_id','phones'],['openingArchiveLocationId','opening_archive_location_id','locations']]){
    const old=raw[column],mapped=old==null?null:ctx.lookup(type,old);
    if((old!=null&&!mapped)||(data[field]??null)!==(mapped??null))throw fail('原人员或资料关联不一致');
  }
  if((data.reconcileCycle??null)!==(raw.reconciliation_cycle||null))throw fail('原对账周期不一致');
  const {balance:_,...original}=data;
  const archivedBy=raw.archived_by==null?undefined:ctx.lookup('user',raw.archived_by);
  if(raw.archived_by!=null&&!archivedBy)throw fail('原归档人未迁入');
  if(raw.archived_at!=null)legacyWallTime(raw.archived_at,true);
  const values={...original,bankAccountId:parent.id,sourceId,originalBalance:balance,sourceCreatedAt:raw.created_at,sourceScope:raw.account_scope,sourceStatus:raw.status,
    sourceArchivedAt:raw.archived_at,sourceArchivedBy:archivedBy,sourceArchiveReason:raw.archive_reason,sourceArchivedFromStatus:raw.archived_from_status};
  const clean=validateResourceInput(getResourceDef(TYPE)!,values,{status:'recorded'});
  if(clean.errors.length)throw fail('原字段不能无损对应');
  const proof=sourceRowHash(raw);
  const verifyView=async(id:number)=>{
    const bound=Object.create(em.connection) as DataSource;Object.defineProperty(bound,'manager',{value:em});
    const viewer=Object.create(ctx.resources) as ResourcesService;Object.defineProperty(viewer,'dataSource',{value:bound});
    const dto=await viewer.get(user,TYPE,id);
    if(Object.keys(dto.data).some(k=>k.startsWith('_legacy')))throw fail('内部来源证据外泄');
    for(const [field,value] of Object.entries(clean.values))if(value!=null&&dto.data[field]!==value)throw fail('原登记页面读取与源值不一致');
  };
  const old=await ctx.resources.findByUnique(em,user.companyId,TYPE,sourceId);
  if(old){
    if(old.data._legacySourceHash!==proof||old.data.bankAccountId!==parent.id)throw fail('已迁来源或所属账户变化');
    const secrets=old.secrets?JSON.parse(old.secrets):{};
    for(const [key,value] of Object.entries(clean.values)){
      const actual=key==='accountNo'&&secrets[key]?ctx.crypto.decrypt(secrets[key]):old.data[key];
      if(value!=null&&value!==actual)throw fail('已迁登记与原资料不一致，未覆盖');
    }
    await verifyView(old.id);return {id:old.id,reused:true};
  }
  const record=await withReadonlyAppend(em,user.companyId,TYPE,()=>ctx.resources.createRecord(em,user,TYPE,values,'原账户登记快照；余额不参与重复入账'));
  record.data={...record.data,_legacySourceHash:proof};await em.save(ResourceRecord,record);
  await verifyView(record.id);
  return {id:record.id,reused:false};
}
