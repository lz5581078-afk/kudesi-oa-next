import { createHash } from 'node:crypto';
import { DataSource,type EntityManager } from 'typeorm';
import { Company,User } from '../entities';
import { CryptoService } from '../common/crypto.service';
import { ResourcesService } from '../resources/resources.service';
import { FilesService } from '../integrations/files.service';
import { encodeLegacyPassword } from '../auth/password';
import type { LegacyArchive } from './protocol';
import { runLegacyImport,MigrationError,type ImportResult } from './runner';
import { deferredReportDigest } from './deferred-scope';
import { LEGACY_SESSION_TABLES } from '../database/migrations/1777000000000-SessionLegacyRuntime';

const known=new Set(`workforce_login_secrets staff_enrollment_invites after_sales_cases agent_releases ai_company_settings ai_models ai_providers audit_logs bundle_archive_jobs bundle_price_logs case_logs companies company_applications departments employee_compensation_records feishu_identities feishu_oauth_states finance_api_keys finance_cost_snapshots finance_doc_counters finance_document_accounts finance_document_events finance_document_lines finance_document_settlements finance_documents finance_entries finance_fee_snapshots finance_key_accounts finance_master_snapshots finance_product_data_verification_events flow_ccs flow_definitions flow_events flow_node_templates flow_reminder_logs flow_runs flow_steps flow_templates flow_timeout_events flow_timeout_incidents flow_timeout_penalties flow_timeout_policies form_drafts integration_settings jst_category_links jst_category_runs legacy_import_links legacy_source_rows live_daily_work live_checkin_qr_codes live_commission_records live_commission_rule_versions live_notification_settings live_notification_events live_notification_health live_room_settings live_trial_tickets live_schedules live_session_checkins live_session_order_snapshots live_session_orders live_session_products live_session_reports live_sessions live_turnover_snapshots live_settlement_lines live_settlement_refunds live_settlements live_wage_records migrations notifications order_appeals outbox_jobs outbox_switches phone_upload_sessions platform_admins platform_integration_apps position_duties position_permissions positions resource_category_options resource_change_logs resource_files resource_import_backups resource_links resource_records session_audit_logs session_bind_codes session_devices session_open_requests session_remote_devices session_remote_sessions session_remote_signals session_shops supervision_exceptions supervision_rules task_delay_requests task_routines user_permission_overrides users work_items`.split(' '));
const technical=new Set(['companies','migrations','platform_admins','platform_integration_apps','agent_releases','integration_settings','ai_company_settings','ai_models','ai_providers','outbox_switches']);
const qi=(n:string)=>{if(!/^[a-z_]+$/.test(n))throw new MigrationError('切换表名未核实');return '`'+n+'`';};
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const rowDigest=(rows:any[])=>hash(rows.map(r=>JSON.stringify(r)).sort());
export interface CompanyPlan {sourceCompanyId:number;companyId:number;actorId:number;name:string}
export interface CutoverResult {version:1;phase:string;softwareFingerprint:string;backupDigest:string;technicalBefore:string;technicalAfter:string;plans:CompanyPlan[];reports:ImportResult[];deferred:true;detachedTechnicalOwners:Array<{companyId:number;table:string;key:string;oldUserId:number}>;cleared:Record<string,number>;counts:Record<string,number>}
export interface CutoverOptions {apply:boolean;softwareFingerprint:string;backupDigest:string;plans:CompanyPlan[];expected?:CutoverResult;writeReport?:(r:CutoverResult)=>void;verify?:(em:EntityManager,r:CutoverResult)=>Promise<void>}

export async function cutoverTables(ds:DataSource){
  const rows:Array<{name:string}>=await ds.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
  const compatibleKnown=new Set([...known,...LEGACY_SESSION_TABLES]);
  if(rows.some(r=>!compatibleKnown.has(r.name))||rows.length!==compatibleKnown.size)throw new MigrationError('目标结构与切换清单不同，禁止清理未知表');
  // A newly migrated empty session schema must not disable the existing importer.
  // Once these two modules have data, refuse destructive full remigration rather
  // than silently deleting or orphaning their devices, mappings and credentials.
  for(const table of LEGACY_SESSION_TABLES){const [row]=await ds.query(`SELECT 1 occupied FROM ${qi(table)} LIMIT 1`);if(row)throw new MigrationError('店铺登录兼容模块已有数据，禁止整库重新迁入；需先单独核对这两个模块');}
  return rows.map(r=>r.name);
}
/** Sequence DDL is deliberately outside the business transaction. It never
 * lowers any preexisting identity; rolled-back rehearsals have no public IDs. */
export async function prepareCutoverSequences(ds:DataSource,floor:number){
  const tables=await cutoverTables(ds);if(!Number.isSafeInteger(floor)||floor<1000000||floor>2000000000)throw new MigrationError('切换身份边界无效');
  const cols:Array<{name:string}>=await ds.query("SELECT TABLE_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND EXTRA LIKE '%auto_increment%'");
  for(const {name}of cols.filter(r=>tables.includes(r.name)&&!technical.has(r.name))){
    const [r]=await ds.query(`SELECT MAX(id) n FROM ${qi(name)}`);if(Number(r.n??0)>=floor)throw new MigrationError('切换身份边界必须高于全部清理前业务编号');
    await ds.query(`ALTER TABLE ${qi(name)} AUTO_INCREMENT=${floor}`);
  }
}

/** One owner for clear, both companies, technical reference remapping, file
 * verification and commit. Never commits the first company independently. */
export async function runCutover(ds:DataSource,resources:ResourcesService,files:FilesService,crypto:CryptoService,sources:LegacyArchive[],opts:CutoverOptions):Promise<CutoverResult>{
  if(!/^[a-f0-9]{64}$/.test(opts.backupDigest)||!/^[a-f0-9]{64}$/.test(opts.softwareFingerprint))throw new MigrationError('切换缺少程序/已验证备份摘要');
  if(opts.apply&&!opts.expected)throw new MigrationError('正式切换缺少统一空跑报告');
  const tables=await cutoverTables(ds),q=ds.createQueryRunner();await q.connect();let committed=false;
  const result:CutoverResult={version:1,phase:'started; not committed',softwareFingerprint:opts.softwareFingerprint,backupDigest:opts.backupDigest,technicalBefore:'',technicalAfter:'',plans:opts.plans,reports:[],deferred:true,detachedTechnicalOwners:[],cleared:{},counts:{}};
  try{
    const [lock]=await q.query("SELECT GET_LOCK('kudesi-full-remigration',0) acquired");if(Number(lock.acquired)!==1)throw new MigrationError('已有统一迁移在运行');
    await q.startTransaction('REPEATABLE READ');q.data.cutoverPrepareOnly=!opts.apply;const em=q.manager;
    // Recheck under current locks before any deletion. Empty-table supremum
    // locks also prevent adoption/candidate inserts racing this full cutover.
    for(const table of LEGACY_SESSION_TABLES){const [row]=await em.query(`SELECT 1 occupied FROM ${qi(table)} LIMIT 1 FOR UPDATE`);if(row)throw new MigrationError('店铺登录兼容模块已有数据，禁止整库重新迁入；需先单独核对这两个模块');}
    const companies=await em.find(Company),oldUsers=await em.find(User);
    const oldUserLinks:Array<{companyId:number;sourceCompanyId:number;sourceKey:string;targetId:number}>=await em.query("SELECT company_id companyId,source_company_id sourceCompanyId,source_key sourceKey,target_id targetId FROM legacy_import_links WHERE source_system='legacy-oa' AND target_type='user'");
    if(sources.length!==opts.plans.length||new Set(opts.plans.map(p=>p.companyId)).size!==sources.length||new Set(opts.plans.map(p=>p.actorId)).size!==sources.length||companies.some(c=>!opts.plans.some(p=>p.companyId===c.id&&p.name===c.name)))throw new MigrationError('全部公司切换范围不一致');
    const preserved=new Map<string,any[]>();for(const table of technical)preserved.set(table,await em.query(`SELECT * FROM ${qi(table)}`));
    result.technicalBefore=hash([...preserved].filter(([t])=>t!=='companies').map(([t,rows])=>[t,rowDigest(rows)]));
    if(opts.expected&&(opts.expected.version!==1||opts.expected.softwareFingerprint!==opts.softwareFingerprint||opts.expected.backupDigest!==opts.backupDigest||opts.expected.technicalBefore!==result.technicalBefore||JSON.stringify(opts.expected.plans)!==JSON.stringify(opts.plans)))throw new MigrationError('技术配置、程序、备份或公司映射在空跑后变化');
    await q.query('SET FOREIGN_KEY_CHECKS=0');
    for(const table of tables.filter(t=>!technical.has(t))){const [r]=await em.query(`SELECT COUNT(*) n FROM ${qi(table)}`);result.cleared[table]=Number(r.n);await em.query(`DELETE FROM ${qi(table)}`);}
    for(const plan of opts.plans){
      const source=sources.find(s=>s.company.id===plan.sourceCompanyId);if(!source||source.company.name!==plan.name)throw new MigrationError('旧公司身份不一致');
      let company=companies.find(c=>c.id===plan.companyId);
      if(!company)company=await em.save(Company,em.create(Company,{id:plan.companyId,code:'legacy-'+source.company.id,name:plan.name,status:'active'}));
      if(company.name!==plan.name)throw new MigrationError('目标公司身份不一致');
      const boss=source.employees.find(e=>e.status==='active'&&['boss','company_admin','admin'].includes(e.role_key)&&String(e.login_account??'').trim());
      if(!boss)throw new MigrationError('来源缺少真实在职管理员，禁止增加临时员工');
      await em.save(User,em.create(User,{id:plan.actorId,companyId:company.id,name:boss.name,account:String(boss.login_account).trim(),passwordHash:encodeLegacyPassword(String(boss.password_salt),String(boss.password_hash)),isCompanyAdmin:true,status:'active',mustChangePassword:false}));
      const prior=opts.expected?.reports.find(r=>r.companyId===plan.companyId);
      if(opts.apply&&!prior)throw new MigrationError('某公司缺少统一核对报告');
      const report=await runLegacyImport(ds,resources,files,source,{companyId:company.id,actorId:plan.actorId,expectedName:plan.name,apply:true,preserveCostHistory:true,preserveLegacyStates:true,sourceRowsCrypto:crypto,softwareFingerprint:opts.softwareFingerprint,transaction:q,bootstrapUser:{sourceId:String(boss.id),targetId:plan.actorId},expectedReport:prior,...(opts.apply?{deferredScope:{version:1 as const,decision:'verified-scope-first-retain-rest' as const,backupDigest:opts.backupDigest,reportDigest:deferredReportDigest(prior!)}}:{})});
      if(report.failures.length)throw new MigrationError('任一公司仍有迁入失败，统一回滚');
      result.reports.push(report);
    }
    const freshUsers=await em.find(User);if(freshUsers.length!==sources.reduce((n,s)=>n+s.employees.length,0))throw new MigrationError('人员数量与原始公司不一致');
    const remapUser=(companyId:number,id:unknown,nullableAttribution?:{table:string;key:string})=>{
      if(id==null)return null;const original=oldUsers.find(u=>u.companyId===companyId&&u.id===Number(id));
      const matches=original?.account?freshUsers.filter(u=>u.companyId===companyId&&u.account===original.account):[];
      const plan=opts.plans.find(p=>p.companyId===companyId),links=oldUserLinks.filter(l=>Number(l.companyId)===companyId&&Number(l.targetId)===Number(id)&&Number(l.sourceCompanyId)===plan?.sourceCompanyId);
      if(matches.length>1||links.length>1)throw new MigrationError('技术配置原身份映射不唯一');
      const ledger=links[0];if(ledger&&!/^user:[1-9]\d*$/.test(ledger.sourceKey))throw new MigrationError('原人员来源账本身份无效');
      const linked=ledger?result.reports.find(r=>r.companyId===companyId)?.mappings.find(m=>m.type==='user'&&m.sourceId===ledger.sourceKey.slice(5))?.targetId:undefined;
      if(ledger&&!linked)throw new MigrationError('技术配置来源人员账本未迁入');
      if(matches[0]&&linked&&matches[0].id!==linked)throw new MigrationError('技术配置账号与来源账本身份冲突');
      if(matches[0]||linked)return matches[0]?.id??linked!;
      // The removed target-only bootstrap admin is not an old employee. Do
      // not invent a new employee or credit someone else with their changes.
      // Nullable attribution is detached with explicit audit + retained backup;
      // live recipients/authority still require a real, unambiguous identity.
      if(nullableAttribution&&original){result.detachedTechnicalOwners.push({companyId,...nullableAttribution,oldUserId:original.id});return null;}
      throw new MigrationError('技术配置原账号在迁入人员中不唯一或缺失');
    };
    for(const table of ['integration_settings','ai_providers','ai_company_settings','outbox_switches']){
      for(const original of preserved.get(table)!){
        const row={...original};for(const field of ['updated_by','created_by'])if(Object.hasOwn(row,field)&&row[field]!=null)row[field]=remapUser(Number(row.company_id),row[field],{table,key:String(row.id??row.setting_key??row.channel)+':'+field});
        if(table==='integration_settings'&&row.setting_key==='feishu'){
          const value=JSON.parse(crypto.decrypt(row.config_enc));let changed=false;
          for(const channel of value.channels??[])if(Array.isArray(channel.recipientUserIds)&&channel.recipientUserIds.length){channel.recipientUserIds=channel.recipientUserIds.map((id:unknown)=>remapUser(Number(row.company_id),id));changed=true;}
          if(changed)row.config_enc=crypto.encrypt(JSON.stringify(value));
        }
        const fields=Object.keys(row).filter(k=>JSON.stringify(row[k])!==JSON.stringify(original[k]));
        if(fields.length){
          const keys=Object.hasOwn(row,'id')?['id']:['company_id',table==='outbox_switches'?'channel':'setting_key'];
          const update=[...fields,...(Object.hasOwn(row,'updated_at')&&!fields.includes('updated_at')?['updated_at']:[])];
          await em.query(`UPDATE ${qi(table)} SET ${update.map(k=>qi(k)+'=?').join(',')} WHERE ${keys.map(k=>qi(k)+'=?').join(' AND ')}`,[...update.map(k=>row[k]),...keys.map(k=>original[k])]);
        }
        Object.assign(original,row);
      }
    }
    if(opts.expected&&JSON.stringify(result.detachedTechnicalOwners)!==JSON.stringify(opts.expected.detachedTechnicalOwners))throw new MigrationError('待保留的技术配置原更新人范围变化');
    for(const old of result.detachedTechnicalOwners)await em.query('INSERT INTO audit_logs (company_id,actor_id,action,resource_type,resource_id,detail) VALUES (?,?,?,?,?,?)',[old.companyId,opts.plans.find(p=>p.companyId===old.companyId)!.actorId,'legacy.technical-owner-detach','technical-config',old.key,JSON.stringify({...old,reason:'清理前新站专有账号无旧站对应；原更新人保留在完整备份，未冒认其他员工'})]);
    // No migrated historical message or automatic scanner may write externally.
    for(const plan of opts.plans)for(const channel of ['feishu','jushuitan','jst_price'])await em.query('INSERT INTO outbox_switches (company_id,channel,enabled,note,updated_by) VALUES (?,?,0,?,?) ON DUPLICATE KEY UPDATE enabled=0,note=VALUES(note),updated_by=VALUES(updated_by)',[plan.companyId,channel,'迁移后待核对，保留历史不重放',plan.actorId]);
    const after=[];for(const [table,rows]of preserved){if(['companies','outbox_switches'].includes(table))continue;const got=await em.query(`SELECT * FROM ${qi(table)}`);if(rowDigest(got)!==rowDigest(rows))throw new MigrationError('保留技术配置发生未核准变化');after.push([table,rowDigest(got)]);}
    result.technicalAfter=hash(after);
    const fks:Array<{tableName:string;columnName:string;parentName:string;parentColumn:string}>=await em.query('SELECT TABLE_NAME tableName,COLUMN_NAME columnName,REFERENCED_TABLE_NAME parentName,REFERENCED_COLUMN_NAME parentColumn FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA=DATABASE()');
    for(const fk of fks){const [r]=await em.query(`SELECT COUNT(*) n FROM ${qi(fk.tableName)} c LEFT JOIN ${qi(fk.parentName)} p ON c.${qi(fk.columnName)}=p.${qi(fk.parentColumn)} WHERE c.${qi(fk.columnName)} IS NOT NULL AND p.${qi(fk.parentColumn)} IS NULL`);if(Number(r.n)!==0)throw new MigrationError('切换后存在无效外键引用');}
    await q.query('SET FOREIGN_KEY_CHECKS=1');
    for(const table of tables){const [r]=await em.query(`SELECT COUNT(*) n FROM ${qi(table)}`);result.counts[table]=Number(r.n);}
    if(opts.expected&&JSON.stringify(result.counts)!==JSON.stringify(opts.expected.counts))throw new MigrationError('统一切换全部表计数与空跑不一致');
    if(opts.expected&&JSON.stringify(result.cleared)!==JSON.stringify(opts.expected.cleared))throw new MigrationError('清理范围在空跑后变化');
    await opts.verify?.(em,result);
    result.phase='prepared; not committed';opts.writeReport?.(result);
    if(opts.apply){await q.commitTransaction();committed=true;result.phase='committed; verified scope, deferred data retained';}
    else{await q.rollbackTransaction();result.phase='dry-run-rollback';for(const r of result.reports)r.phase='dry-run-rollback';}
    opts.writeReport?.(result);return result;
  }catch(e){if(!committed&&q.isTransactionActive)await q.rollbackTransaction();result.phase=committed?'committed; final reporting needs reconciliation':'rejected; all companies rolled back';try{opts.writeReport?.(result);}catch{}throw e;
  }finally{
    if(!committed){const keys:string[]=q.data.importUploadedKeys??[];for(const companyId of opts.plans.map(p=>p.companyId))await files.deleteObjects(companyId,keys.filter(k=>k.replace(/^local:/,'').startsWith('oa/'+companyId+'/')));}
    try{await q.query('SET FOREIGN_KEY_CHECKS=1');await q.query("SELECT RELEASE_LOCK('kudesi-full-remigration')");}finally{await q.release();}
  }
}
