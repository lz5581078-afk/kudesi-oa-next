import { importFinanceLedger } from './finance-ledger-import';
import { withLegacyTax } from './legacy-tax-context';
import { mapLegacyPermission } from './permissions';
import { createHash } from 'node:crypto';
import { DataSource,type QueryRunner } from 'typeorm';
import { deferredScopeMatches,type DeferredScope } from './deferred-scope';
import { Company, Department, Position, PositionDuty, EmployeeCompensationRecord, User, PlatformAdmin, PositionPermission, UserPermissionOverride, ResourceRecord, ResourceFile, ResourceLink, AuditLog } from '../entities';
import { refreshFromSources, recomputeProduct } from '../resources/finance-rules';
import { ResourcesService } from '../resources/resources.service';
import { FilesService } from '../integrations/files.service';
import { AuthUser } from '../common/auth.decorators';
import { ARCHIVE_POLICY, yuanToPreciseCents, normalizePhone, getResourceDef, workspaceTypeFromLegacyTemplate } from '@kudesi/shared';
import { encodeLegacyPassword } from '../auth/password';
import { aliasCode } from '../resources/base-code-support';
import { LegacyArchive, LegacyRecord, LegacyRef } from './protocol';
import { importLive, liveHashGroups, LIVE_TARGET_TABLE } from './live-import';
import type { CryptoService } from '../common/crypto.service';
import { preserveSourceRow, sourceRowHash } from './source-rows';
import { withCostHistory } from './cost-history-context';
import { importWorkflows, workflowHashGroups, WORKFLOW_TARGET_TABLE } from './workflow-import';
import { restoreBaseVerifications, restoreBundleVerifications } from './verification-restore';
import { withMissingLegacyReason } from './legacy-state-context';
import { importFeishuIdentity,feishuIdentityKey } from './feishu-identities';
import { importBankRegistration } from './bank-registration-import';
import { importPhoneRegistrations } from './phone-registration-import';
import { verifyGiftAliasIndex } from './gift-alias-index';
import { OrgAdminService } from '../org/org-admin.service';
import { legacyWallTime } from './legacy-time';
import { isRegistrationType } from '../resources/legacy-registration';
import { verifyPhoneRechargeView } from './phone-recharge-view';
import { verifyResponsibilityDuplicates } from './responsibility-duplicates';
import { sourceFieldCoverage,type FieldCoverage } from './field-coverage';
import { employeePositions } from './employee-positions';
import { verifyEmployeePositionView } from './employee-position-view';

const SOURCE = 'legacy-oa';
function stable(v: unknown): unknown {
  if(Array.isArray(v)) return v.map(stable);
  if(v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='locator').sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)]));
  return v;
}
export interface ImportResult { fieldCoverage?:FieldCoverage;softwareFingerprint?:string;targetFingerprint?:string;verified?:Record<string,number>; sourceFingerprint: string; phase: string; companyId: number; created: Record<string, number>; reused: Record<string, number>; excluded: Array<{ type: string; id: string; reason: string }>; failures: Array<{ type: string; id: string; reason: string }>; mappings: Array<{ type: string; sourceId: string; targetId: number }>; archived: { total: number; byType: Record<string, number>; skipped: Array<{ type: string; id: string; reason: string }> }; links: { created: number; reused: number; skipped: number; skippedReasons: Record<string, number>; byRelation: Record<string, { created: number; skipped: number }> } }
class MissingRef extends Error {}
export class MigrationError extends Error {}
export function safeFailure(e: unknown): string {
  if(e instanceof MigrationError || (e instanceof Error && e.name==='LegacyDataError'))return e.message;
  const x = e as { code?: string; getResponse?: () => unknown; name?: string };
  if (x.code) return x.code;
  if (x.getResponse) return JSON.stringify(x.getResponse()).replace(/「[^」]*」/g, '「已隐藏」').replace(/[0-9]{6,}/g, '[数字已隐藏]');
  return x.name ?? '导入校验失败';
}

/** 无后台服务/外部worker；整个批次与对照账本同一事务，试跑完整回滚。 */
export async function runLegacyImport(ds: DataSource, resources: ResourcesService, files: FilesService, source: LegacyArchive, opts: { companyId: number; actorId: number; expectedName: string; apply: boolean; preserveCostHistory?: boolean; preserveLegacyStates?: boolean; sourceRowsCrypto?: CryptoService; expectedReport?: ImportResult; prepareReport?: (result:ImportResult)=>void; rollbackReport?: (result:ImportResult)=>void;softwareFingerprint?:string;transaction?:QueryRunner;bootstrapUser?:{sourceId:string;targetId:number};deferredScope?:DeferredScope }): Promise<ImportResult> {
  for(const [rows,parent] of [[source.departments,'parent_department_id'],[source.positions,'supervisor_position_id'],[source.employees,'manager_id']] as Array<[Array<Record<string,any>>,string]>) {
    const parents=new Map(rows.map(r=>[String(r.id),r[parent]?String(r[parent]):null]));
    for(const r of rows){const seen=new Set<string>();let id:string|null=String(r.id);while(id){if(seen.has(id))throw new MigrationError('来源组织引用存在循环，不能直接迁入');seen.add(id);id=parents.get(id)??null;}}
  }
  const external=opts.transaction;
  if(external&&(!external.isTransactionActive||external.connection!==ds||!opts.apply))throw new MigrationError('整批迁入必须使用本库有效外层事务');
  if(opts.bootstrapUser&&(!external||opts.bootstrapUser.targetId!==opts.actorId))throw new MigrationError('原管理员引导仅限统一切换事务');
  if(opts.deferredScope&&(!external||!deferredScopeMatches(opts.deferredScope,opts.expectedReport)))throw new MigrationError('分阶段切换未绑定已核对报告及保留备份');
  const q = external??ds.createQueryRunner(); if(!external){await q.connect();await q.startTransaction();}
  q.data.legacyImport = true;
  const em = q.manager;
  const out: ImportResult = { verified:{}, sourceFingerprint:'', phase: opts.apply ? 'apply' : 'dry-run-rollback', companyId: opts.companyId, created: {}, reused: {}, excluded: [...source.exclusions], failures: [], mappings: [], archived: { total: 0, byType: {}, skipped: [] }, links: { created: 0, reused: 0, skipped: 0, skippedReasons: {}, byRelation: {} } };
  const ids = new Map<string, number>();
  const hashes = new Map<string,string>();
  const orgCreated=new Set<string>();
  const resourceCreated=new Set<number>();
  const key = (type: string, id: unknown) => `${type}:${String(id)}`;
  for(const [type,rows] of [['department',source.departments],['position',source.positions],['user',source.employees],['position_duty',source.positionDuties??[]],['comp_record',source.compensationRecords??[]],['finance-ledger-history',(source.sourceRows??[]).filter(r=>r.table==='finance_entries').map(r=>({id:r.key,row:r.row}))],...['resource'].map(t=>[t,source.records]),['link',source.links??[]],...liveHashGroups(source.live),...workflowHashGroups(source.workflow)] as Array<[string,Array<Record<string,any>>]>) {
    for(const r of rows) hashes.set(key(type==='resource'?r.type:type,r.id),WORKFLOW_TARGET_TABLE[type] ? sourceRowHash(r) : createHash('sha256').update(JSON.stringify(stable(r))).digest('hex'));
  }
  for(const row of source.feishuBindings??[])hashes.set(key('feishu_identity',feishuIdentityKey(row)),sourceRowHash(row));
  if(opts.preserveLegacyStates)for(const row of source.sourceRows??[])if(row.table==='position_responsibilities')hashes.set(key('position_responsibility',row.row.id),sourceRowHash(row.row));
  if(opts.preserveLegacyStates)for(const r of source.records.filter(r=>r.type==='bank-accounts')){
    const raw=source.sourceRows?.find(row=>row.table==='bank_accounts'&&String(row.row.id)===r.id);
    if(raw)hashes.set(key('bank-account-history',r.id),sourceRowHash(raw.row));
  }
  if(opts.preserveLegacyStates)for(const r of source.records.filter(r=>r.type==='phones')){
    const raw=source.sourceRows?.find(row=>row.table==='phone_numbers'&&String(row.row.id)===r.id);
    if(raw)hashes.set(key('phone-registration-history',r.id),sourceRowHash(raw.row));
  }
  out.sourceFingerprint=createHash('sha256').update(JSON.stringify(stable({hashes:[...hashes].sort(([a],[b])=>a.localeCompare(b)),company:source.company,exclusions:source.exclusions,sourceRows:(source.sourceRows??[]).map(r=>({table:r.table,key:r.key,hash:sourceRowHash(r.row)})),employeePositions:source.employeePositions,positionPermissions:source.positionPermissions,employeeOverrides:source.employeeOverrides??[],...(source.workflow?{workflow:source.workflow}:{})}))).digest('hex');
  const count = (which: 'created' | 'reused', type: string) => { out[which][type] = (out[which][type] ?? 0) + 1; };
  const lookup = (type: string, id: unknown) => ids.get(key(type, id));
  const required = (type: string, id: unknown) => { const n = lookup(type, id); if (!n) throw new MissingRef(key(type, id)); return n; };
  const register = async (type: string, id: unknown, targetId: number) => {
    await em.query('INSERT INTO legacy_import_links (source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES (?,?,?,?,?,?,?)', [SOURCE, source.company.id, opts.companyId, key(type, id), type, targetId, hashes.get(key(type,id)) ?? createHash('sha256').update(key(type,id)).digest('hex')]);
    ids.set(key(type, id), targetId); out.mappings.push({ type, sourceId: String(id), targetId });
  };
  const reuse = (type: string, id: unknown) => { const n = lookup(type, id); if (n) count('reused', type); return n; };
  let serial = 0;
  const savepoint = async <T>(fn: () => Promise<T>): Promise<T> => {
    const name = `legacy_${++serial}`; await em.query(`SAVEPOINT ${name}`);
    const prior = { ids: new Map(ids), created: { ...out.created }, reused: { ...out.reused }, mappings: out.mappings.length, excluded: out.excluded.length, uploaded: (q.data.importUploadedKeys ?? []).length };
    try { const r = await fn(); await em.query(`RELEASE SAVEPOINT ${name}`); return r; }
    catch (e) { await em.query(`ROLLBACK TO SAVEPOINT ${name}`); await em.query(`RELEASE SAVEPOINT ${name}`);
      ids.clear(); for (const [k,v] of prior.ids) ids.set(k,v);
      out.created = prior.created; out.reused = prior.reused; out.mappings.length = prior.mappings; out.excluded.length = prior.excluded;
      const discarded: string[] = (q.data.importUploadedKeys ?? []).splice(prior.uploaded);
      if (discarded.length) await files.deleteObjects(opts.companyId, discarded);
      throw e; }
  };
  const resolve = (data: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(data).map(([k, value]) => {
    const ref = (value as LegacyRef | undefined)?.legacyRef;
    if (ref) return [k, required(ref.type, ref.id)];
    if (Array.isArray(value)) return [k, value.map((v) => (v as LegacyRef)?.legacyRef ? required(v.legacyRef.type, v.legacyRef.id) : v)];
    return [k, value];
  }));
  try {
    const company = await em.findOneByOrFail(Company, { id: opts.companyId });
    if(opts.preserveLegacyStates&&(company.name!==opts.expectedName||source.company.name!==opts.expectedName))throw new MigrationError('完整重迁必须匹配来源、目标与核对公司名，禁止将公司混导');
    if (company.name !== opts.expectedName && company.name !== source.company.name) throw new MigrationError('目标公司名与核对条件不符');
    const actor = await em.findOneByOrFail(User, { id: opts.actorId, companyId: opts.companyId, isCompanyAdmin: true, status: 'active' });
    const [database]=await em.query('SELECT DATABASE() databaseName,@@server_uuid serverUuid');
    if(typeof database.databaseName!=='string'||!database.databaseName||typeof database.serverUuid!=='string'||!database.serverUuid)throw new MigrationError('无法核实目标数据库身份');
    out.targetFingerprint=createHash('sha256').update(JSON.stringify({database:database.databaseName,server:database.serverUuid,companyId:company.id,actorId:actor.id,sourceCompanyId:source.company.id})).digest('hex');
    if(opts.softwareFingerprint){if(!/^[0-9a-f]{64}$/.test(opts.softwareFingerprint))throw new MigrationError('迁移程序指纹格式不正确');out.softwareFingerprint=opts.softwareFingerprint;}
    if(opts.expectedReport&&(opts.expectedReport.companyId!==out.companyId||opts.expectedReport.targetFingerprint!==out.targetFingerprint||opts.expectedReport.softwareFingerprint!==out.softwareFingerprint||opts.expectedReport.sourceFingerprint!==out.sourceFingerprint)){
      out.phase=opts.apply?'apply-rejected-rollback':'dry-run-rejected-rollback';
      out.failures.push({type:'preflight',id:'report-identity',reason:'目标库/公司/操作人、迁移程序或来源与已核对报告不一致'});
      throw new MigrationError('本批结果与已核对试迁不一致，整批回滚');
    }
    const user: AuthUser = { id: actor.id, companyId: company.id, name: actor.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    if (source.sourceRows?.length) {
      if (!opts.sourceRowsCrypto) throw new MigrationError('原始资料保留缺少目标加密服务');
      for (const row of source.sourceRows) {
        const stored = await preserveSourceRow(em, opts.sourceRowsCrypto, { companyId: company.id, sourceCompanyId: source.company.id, table: row.table, key: row.key }, row.row);
        count(stored.reused ? 'reused' : 'created', 'legacy-source-row');
      }
    }
    const oldLinks: Array<{ source_key: string; target_type: string; target_id: number; source_hash: string }> = await em.query('SELECT source_key,target_type,target_id,source_hash FROM legacy_import_links WHERE source_system=? AND source_company_id=? AND company_id=?', [SOURCE, source.company.id, company.id]);
    for (const l of oldLinks) {
      if(hashes.has(l.source_key) && hashes.get(l.source_key)!==l.source_hash) throw new MigrationError('来源资料已变化，禁止复跑静默复用或覆盖；请先核对增量');
      if(l.target_type==='feishu_identity'){
        const [row]=await em.query('SELECT id FROM feishu_identities WHERE id=? AND company_id=?',[l.target_id,company.id]);
        if(!row)throw new MigrationError('飞书身份迁移账本引用失效，禁止自动补造');
        ids.set(l.source_key,Number(l.target_id));continue;
      }
      if (WORKFLOW_TARGET_TABLE[l.target_type]) {
        const [row] = await em.query(`SELECT id FROM ${WORKFLOW_TARGET_TABLE[l.target_type]} WHERE id=? AND company_id=?`, [l.target_id, company.id]);
        if (!row) throw new MigrationError('旧流程迁移账本引用失效，禁止自动补造');
        ids.set(l.source_key, Number(l.target_id)); continue;
      }
      if (LIVE_TARGET_TABLE[l.target_type]) {
        const [row] = await em.query(`SELECT id FROM ${LIVE_TARGET_TABLE[l.target_type]} WHERE id = ? AND company_id = ?`, [l.target_id, company.id]);
        if (!row) throw new MigrationError('迁移账本引用已失效，必须先核对，不能自动补造');
        ids.set(l.source_key, Number(l.target_id)); continue;
      }
      const entity = l.target_type === 'user' ? User : l.target_type === 'department' ? Department : l.target_type === 'position' ? Position : ['position_duty','position_responsibility'].includes(l.target_type) ? PositionDuty : l.target_type === 'comp_record' ? EmployeeCompensationRecord : l.target_type === 'file' ? ResourceFile : l.target_type === 'link' ? ResourceLink : ResourceRecord;
      const exists = await em.findOne(entity as typeof User, { where: { id: l.target_id, companyId: company.id } });
      if (!exists && l.target_type === 'link') { ids.set(l.source_key, Number(l.target_id)); continue; } // 手动关联被人工取消后，复跑不重建
      if (!exists) throw new MigrationError('迁移账本引用已失效，必须先核对，不能自动补造');
      ids.set(l.source_key, Number(l.target_id));
    }
    // 部门、岗位先建立实体，再回填父级；来源孤立引用直接中止组织批次。
    for (const d of source.departments) {
      if (reuse('department', d.id)) continue;
      if (!d.name || String(d.name).length > 100) throw new MigrationError('部门名称不合法');
      if(d.is_system!=null&&![0,1,'0','1',true,false].includes(d.is_system))throw new MigrationError('旧部门系统标志无效，禁止当作普通部门');
      const isSystem=d.is_system===1||d.is_system==='1'||d.is_system===true;
      const r = await em.save(Department, em.create(Department, { companyId: company.id, name: d.name, parentId: null, sortOrder: Number(d.sort_order || 0), status: d.status === 'active' ? 'active' : 'inactive',isSystem }));
      if((await em.findOneByOrFail(Department,{id:r.id,companyId:company.id})).isSystem!==isSystem)throw new MigrationError('旧部门系统标志落库不一致');
      out.verified!['department-system-flag']=(out.verified!['department-system-flag']??0)+1;
      await register('department', d.id, r.id); count('created', 'department'); orgCreated.add(key('department', d.id));
    }
    for (const d of source.departments) if (orgCreated.has(key('department',d.id)) && d.parent_department_id) await em.update(Department, { id: required('department', d.id), companyId: company.id }, { parentId: required('department', d.parent_department_id) });
    for (const p of source.positions) {
      if (reuse('position', p.id)) continue;
      const proof=p.legacyWorkspaceResolution;
      if(proof){
        const policy=source.sourceRows?.find(r=>r.table==='legacy_position_workspace_policy'&&r.key==='current')?.row as Record<string,any>|undefined;
        const recorded=policy?.resolutions?.some((r:Record<string,any>)=>r.positionId===String(p.id)&&r.originalTemplateKey===proof.originalTemplateKey&&r.templateKey===proof.templateKey&&r.via===proof.via);
        if((p.workspace_template_key??null)!==proof.originalTemplateKey||!/^[a-f0-9]{64}$/.test(proof.policyHash)||!['explicit','legacy-binding','blank-fallback'].includes(proof.via)||!workspaceTypeFromLegacyTemplate(proof.templateKey)||policy?.policyHash!==proof.policyHash||!recorded)throw new MigrationError('旧岗位工作台解析证据与原值不一致');
      }
      const workspace = workspaceTypeFromLegacyTemplate(proof?.templateKey??p.workspace_template_key) ?? 'blank';
      if (!p.name || String(p.name).length > 100 || !['boss','manager','staff'].includes(p.level)) throw new MigrationError('岗位名称或显式层级待核定');
      let positionName = String(p.name);
      if (await em.findOneBy(Position, { companyId: company.id, name: positionName })) {
        const departmentName = source.departments.find(d => String(d.id) === String(p.department_id))?.name;
        positionName = `${departmentName} / ${p.name}`;
        if (await em.findOneBy(Position, { companyId: company.id, name: positionName })) positionName += `（旧ID ${p.id}）`;
        if (positionName.length > 100) throw new MigrationError('同名岗位区分名称超长');
        out.excluded.push({ type: 'position.name', id: String(p.id), reason: '旧岗位名与目标公司岗位重名，使用来源部门名加岗位名区分；保留旧新ID对照' });
      }
      const r = await em.save(Position, em.create(Position, { companyId: company.id, departmentId: required('department', p.department_id), name: positionName, positionKey: p.position_key ? String(p.position_key).slice(0, 64) : null, workspaceType: workspace, level: p.level, supervisorPositionId: null, description: p.description, status: p.status === 'active' ? 'active' : 'inactive' }));
      await register('position', p.id, r.id); count('created', 'position'); orgCreated.add(key('position', p.id));
      if (workspace === 'blank'&&!proof) out.excluded.push({ type: 'position.workspaceType', id: String(p.id), reason: '旧岗位未提供新系统支持的显式工作台类型，保留空白，不按名称猜测' });
    }
    for (const p of source.positions) if (orgCreated.has(key('position',p.id)) && p.supervisor_position_id) await em.update(Position, { id: required('position', p.id), companyId: company.id }, { supervisorPositionId: required('position', p.supervisor_position_id) });
    for (const e of source.employees) {
      const bootstrap=opts.bootstrapUser?.sourceId===String(e.id)?opts.bootstrapUser:undefined;
      if (!bootstrap&&reuse('user', e.id)) continue;
      if(bootstrap&&(e.status!=='active'||!['admin','company_admin','boss'].includes(e.role_key)))throw new MigrationError('引导身份必须为原在职管理员');
      const account = String(e.login_account ?? '').trim() || null;
      if (!e.name || String(e.name).length > 50 || (account && account.length > 64)) throw new MigrationError('员工姓名或账号长度不适配');
      if (account && ((!bootstrap&&await em.findOneBy(User, { account })) || await em.findOneBy(PlatformAdmin, { account }))) throw new MigrationError('员工账号与目标系统已有账号冲突，禁止覆盖');
      const {primary,extras} = employeePositions(source,e.id);
      let lastLoginAt:Date|null;
      try{lastLoginAt=legacyWallTime(e.last_login_at);}catch{throw new MigrationError('旧员工最后登录时间无效，禁止改成迁移时间');}
      if(bootstrap){const original=await em.findOneByOrFail(User,{id:bootstrap.targetId,companyId:company.id});if(original.account!==account||original.name!==e.name)throw new MigrationError('引导账号与来源不一致');}
      const r = await em.save(User, em.create(User, { ...(bootstrap?{id:bootstrap.targetId}:{}),companyId: company.id, account, passwordHash: account ? encodeLegacyPassword(String(e.password_salt), String(e.password_hash)) : '!no-login', name: e.name, departmentId: required('department', e.department_id), positionId: primary ? required('position', primary.position_id) : null, extraPositionIds: extras.map((x) => required('position', x.position_id)), managerId: null, title: e.title || null, baseSalary: e.base_salary===null||e.base_salary===undefined?null:yuanToPreciseCents(String(e.base_salary),0), payType: e.pay_type==='hourly'?'hourly':'monthly', hourlyRate: e.hourly_rate===null||e.hourly_rate===undefined?null:yuanToPreciseCents(String(e.hourly_rate),0), employmentType: ['part_time','temp'].includes(e.employment_type)?e.employment_type:'regular', isCompanyAdmin: ['admin','company_admin','boss'].includes(e.role_key), status: e.status === 'active' ? 'active' : 'disabled', mustChangePassword: false,lastLoginAt }));
      if(((await em.findOneByOrFail(User,{id:r.id,companyId:company.id})).lastLoginAt?.getTime()??null)!==(lastLoginAt?.getTime()??null))throw new MigrationError('旧员工最后登录时间落库不一致');
      out.verified!['user-last-login']=(out.verified!['user-last-login']??0)+1;
      await register('user', e.id, r.id); count('created', 'user'); orgCreated.add(key('user', e.id));
    }
    for (const e of source.employees) if (orgCreated.has(key('user',e.id)) && e.manager_id) await em.update(User, { id: required('user', e.id), companyId: company.id }, { managerId: required('user', e.manager_id) });
    for(const row of source.feishuBindings??[]){
      try{
        const originals=source.sourceRows?.filter(r=>r.table==='oa_feishu_bindings'&&String(r.row.employee_id)===String(row.employee_id)&&r.row.app_id===row.app_id)??[];
        if(!opts.preserveLegacyStates||originals.length!==1||sourceRowHash(originals[0].row)!==sourceRowHash(row))throw new MigrationError('飞书身份缺少完整重迁模式的原始归属证据');
        const result=await savepoint(()=>importFeishuIdentity({em,companyId:company.id,sourceCompanyId:source.company.id,lookup,register},row));
        count(result.reused?'reused':'created','feishu-identity');out.verified??={};out.verified['feishu-identity']=(out.verified['feishu-identity']??0)+1;
      }catch(e){out.failures.push({type:'feishu_identity',id:String(row.employee_id),reason:e instanceof Error&&e.message.startsWith('旧飞书')?e.message:safeFailure(e)});}
    }
    for (const p of source.positionPermissions) {
      if(!orgCreated.has(key('position',p.position_id)))continue;
      const oldPermission = p.permission_key ?? p.permission;
      const cohort=source.positionPermissions.filter(x=>String(x.position_id)===String(p.position_id)).map(x=>x.permission_key??x.permission);
      const permission = mapLegacyPermission(oldPermission,cohort);
      if (!permission) { out.excluded.push({ type: 'position.permission', id: `${p.position_id}:${oldPermission}`, reason: '旧权限没有明确的新功能对应，未扩大授权' }); continue; }
      const positionId = required('position', p.position_id);
      if (!await em.findOneBy(PositionPermission, { positionId, permission })) await em.insert(PositionPermission, { positionId, permission });
    }
    for(const override of source.employeeOverrides ?? []) {
      if(!orgCreated.has(key('user',override.employee_id)))continue;
      const cohort=(source.employeeOverrides??[]).filter(x=>String(x.employee_id)===String(override.employee_id)&&x.effect===override.effect).map(x=>x.permission_key);
      const permission=mapLegacyPermission(override.permission_key,cohort);
      if(!permission) {out.excluded.push({type:'user.permission',id:String(override.id),reason:'旧个人权限没有明确的新权限对应，未扩大授权'});continue;}
      const userId=required('user',override.employee_id);
      if(!['allow','deny'].includes(override.effect))throw new MigrationError('旧个人权限效果不合法');
      const existing=await em.findOneBy(UserPermissionOverride,{userId,permission});
      if(!existing) await em.insert(UserPermissionOverride,{userId,permission,effect:override.effect});
      else if(override.effect==='deny'&&existing.effect!=='deny')await em.update(UserPermissionOverride,{userId,permission},{effect:'deny'});
      // 旧同步守卫还检查组合编码页面的显式拒绝；新独立能力也要保留此拒绝。
      if(override.permission_key==='finance-product-bundles.view'&&override.effect==='deny'){
        const permission='finance.bundle-sync.manage';
        if(await em.findOneBy(UserPermissionOverride,{userId,permission}))await em.update(UserPermissionOverride,{userId,permission},{effect:'deny'});
        else await em.insert(UserPermissionOverride,{userId,permission,effect:'deny'});
      }
    }
    // 岗位档案条目（旧 position_duties）：旧分类是业务领域（财务/仓储…），新分类是五类档案；不在新分类里的归“岗位职责”，旧分类名写进说明，不丢
    const DUTY_CATEGORIES = ['岗位职责', '入职培训', '绩效考核', '监督规则', '流程节点说明', '日常工作', '周期工作', '审批职责', '资料维护', '其他'];
    for (const d of source.positionDuties ?? []) {
      if (reuse('position_duty', d.id)) continue;
      const positionId = lookup('position', d.position_id);
      if (!positionId) { out.excluded.push({ type: 'position_duty', id: String(d.id), reason: '旧岗位条目所属岗位不在迁入范围' }); continue; }
      const title = String(d.title ?? '').trim();
      if (!title || title.length > 150) { out.excluded.push({ type: 'position_duty', id: String(d.id), reason: '旧岗位条目标题为空或过长，待核对' }); continue; }
      const oldCategory = String(d.duty_category ?? '').trim();
      const known = DUTY_CATEGORIES.includes(oldCategory);
      const note = !known && oldCategory ? `（旧分类：${oldCategory}）` : '';
      const description = `${String(d.description ?? '')}${note}`.slice(0, 1000) || null;
      const r = await em.save(PositionDuty, em.create(PositionDuty, { companyId: company.id, positionId, category: known ? oldCategory : '岗位职责', title, description, frequency: d.frequency ? String(d.frequency).slice(0, 60) : null, relatedModule: d.related_module ? String(d.related_module).slice(0, 60) : null, completionStandard: d.completion_standard ? String(d.completion_standard).slice(0, 1000) : null, isKey: Number(d.is_key_duty) === 1, status: d.status === 'inactive' ? 'inactive' : 'active' }));
      await register('position_duty', d.id, r.id); count('created', 'position_duty');
    }
    if(opts.preserveLegacyStates){try{
      const rows=(source.sourceRows??[]).filter(r=>r.table==='position_responsibilities').map(r=>r.row);
      const mappings=await verifyResponsibilityDuplicates({em,resources,user,sourceCompanyId:source.company.id,duties:source.positionDuties??[],lookup},rows);
      for(const mapping of mappings){const existing=lookup('position_responsibility',mapping.sourceId);if(existing!=null&&existing!==mapping.targetId)throw new MigrationError('旧岗位职责副本账本引用不一致');if(!existing)await register('position_responsibility',mapping.sourceId,mapping.targetId);count(existing?'reused':'created','position-responsibility-link');}
      out.verified!['position-responsibility-duplicate-view']=mappings.length;
    }catch(e){out.failures.push({type:'position-responsibility-duplicate-view',id:'all',reason:safeFailure(e)});}}
    // 员工薪酬记录（旧 employee_compensation_records：调薪、工资、奖励、处罚）
    for (const c of source.compensationRecords ?? []) {
      if (reuse('comp_record', c.id)) continue;
      const userId = lookup('user', c.employee_id);
      if (!userId) { out.excluded.push({ type: 'comp_record', id: String(c.id), reason: '旧薪酬记录所属员工不在迁入范围' }); continue; }
      if (!['salary_change', 'payroll', 'reward', 'penalty'].includes(String(c.record_type))) { out.excluded.push({ type: 'comp_record', id: String(c.id), reason: '旧薪酬记录类型没有新系统对应，待核对' }); continue; }
      let amount: number;
      try { amount = yuanToPreciseCents(String(c.amount ?? 0), 0); } catch { out.excluded.push({ type: 'comp_record', id: String(c.id), reason: '旧金额精度超出整数分，未舍入，待核对' }); continue; }
      const created = c.created_at ? new Date(String(c.created_at).replace(' ', 'T') + '+08:00') : undefined;
      const r = await em.save(EmployeeCompensationRecord, em.create(EmployeeCompensationRecord, { companyId: company.id, userId, recordType: String(c.record_type), title: String(c.title ?? '').slice(0, 160) || '旧系统薪酬记录', amount, effectiveDate: c.effective_date ? String(c.effective_date).slice(0, 10) : null, payPeriod: c.pay_period ? String(c.pay_period).slice(0, 40) : null, reason: c.reason ? String(c.reason).slice(0, 500) : null, sourceType: c.source_type ? String(c.source_type).slice(0, 80) : 'legacy', sourceId: c.source_id ? String(c.source_id) : null, actorId: c.actor_id ? lookup('user', c.actor_id) ?? null : null, ...(created && !Number.isNaN(created.getTime()) ? { createdAt: created } : {}) }));
      await register('comp_record', c.id, Number(r.id)); count('created', 'comp_record');
    }
    const backfills: Array<{r:LegacyRecord; patch:Record<string,unknown>}> = [];
    const sourceStamps: Array<{id:number;stamp:Date}> = [];
    // 先占用全部旧费用编号，再为原本无编号的资料生成新编号；否则自动编号会抢占后续旧码。
    const needsFeeCode = (r: LegacyRecord) => r.type === 'finance-fee-items' && !String(r.data.code ?? '').trim();
    let pending = [...source.records.filter(r => !needsFeeCode(r)), ...source.records.filter(needsFeeCode)];
    // 按引用依赖排序；依赖失败的记录不会写坏引用。每条失败回滚它产生的全部联动。
    for (let pass = 0; pending.length && pass < 100; pass++) {
      const next: LegacyRecord[] = []; let progress = 0;
      for (const r of pending) {
        if (reuse(r.type, r.id)) { progress++; continue; }
        if (needsFeeCode(r) && pending.some(other => other.type === 'finance-fee-items' && !needsFeeCode(other) && !lookup(other.type, other.id) && !out.failures.some(f => f.type === other.type && f.id === other.id))) { next.push(r); continue; }
        try {
          const definition = getResourceDef(r.type);
          const deferred: Record<string,unknown> = {};
          const immediate = { ...r.data };
          const structural = new Set(['parentId','canonicalId','productId','componentId','baseCodeId','laborId','schemeId','versionId','branchId','carrierId','supplierId','categoryId','bundleId','abnormalReason']);
          for (const [field,v] of Object.entries(immediate)) {
            const link = (v as LegacyRef)?.legacyRef;
            const fd = definition?.fields.find(f=>f.key===field);
            if(link && !lookup(link.type,link.id) && fd && !fd.required && !structural.has(field)) { deferred[field]=v; delete immediate[field]; }
          }
          const data = resolve(immediate);
          const registration=opts.preserveLegacyStates&&isRegistrationType(r.type)?{sourceCompanyId:source.company.id,sourceId:r.id}:undefined;
          await savepoint(async () => {
            const def = getResourceDef(r.type);
            if (!def) throw new MigrationError('目标资料类型不存在');
            let record: ResourceRecord | null = null;
            if (['finance-platforms','finance-scenarios'].includes(r.type) && def.uniqueField) {
              const v = data[def.uniqueField];
              record = typeof v === 'string' ? await resources.findByUnique(em, company.id, r.type, v.toLowerCase()) : null;
              if (record && Object.entries(data).some(([k, v]) => record!.data[k] !== v && !['note','sortOrder'].includes(k))) throw new MigrationError('目标已有字典值不同，禁止覆盖');
            }
            if (!record && def.uniqueField&&!registration) {
              const field = def.fields.find(f=>f.key===def.uniqueField)!;
              const value = data[def.uniqueField];
              const raw = field.type==='phone' ? normalizePhone(String(value??'')) : String(value??'');
              const clash = raw ? await resources.findByUnique(em, company.id, r.type, raw) : null;
              if (clash && out.mappings.some(m=>m.type===r.type && m.targetId===clash.id)) {
                const identity = r.type==='phones' || (r.type==='bank-accounts' && data.accountName===clash.data.accountName && data.bank===clash.data.bank) || (r.type==='licenses' && data.companyName===clash.data.companyName) || (r.type==='finance-fee-items' && data.name===clash.data.name);
                if(identity) {
                  record=clash;
                  if(r.status && r.status!==clash.status)out.excluded.push({type:r.type+'.duplicate.status',id:r.id,reason:'旧库同一唯一编号的状态有差异，保留首条状态；来源对照保留，需核定'});
                  for(const [field,v] of Object.entries(data)) if(v!==clash.data[field] && getResourceDef(r.type)?.fields.find(f=>f.key===field)?.type!=='sensitive' && getResourceDef(r.type)?.fields.find(f=>f.key===field)?.type!=='secret') out.excluded.push({type:r.type+'.duplicate.'+field,id:r.id,reason:'旧库重复唯一编号合并为同一资料，该字段差异保留首条并列出待核对，不覆盖'});
                }
              }
            }
            if (r.sourceLocationOmission) {
              const { row, location } = r.sourceLocationOmission;
              if (!opts.preserveLegacyStates || !opts.sourceRowsCrypto || r.type !== 'licenses' || String(row.id) !== r.id || String(row.company_id) !== String(source.company.id) || String(row.location_id) !== String(location.id) || !location.company_id || String(location.company_id) === String(source.company.id) || location.code !== 'A-02' || data.locationId !== undefined || r.data.locationId !== undefined) throw new MigrationError('旧执照总位置核对证据不完整，禁止忽略关联');
              await preserveSourceRow(em, opts.sourceRowsCrypto, { companyId: company.id, sourceCompanyId: source.company.id, table: 'business_licenses', key: r.id }, row);
              await preserveSourceRow(em, opts.sourceRowsCrypto, { companyId: company.id, sourceCompanyId: source.company.id, table: 'license_location_omissions', key: r.id }, { id: r.id, company_id: source.company.id, location });
              q.data.legacyLicenseLocationNotice = '旧总位置为其他公司的 A-02 默认引用，原始记录已留档；请核对空缺位置，已有分项位置按原记录保留。';
            }
            q.data.legacyAliasName = r.aliasName; q.data.legacyNotices = r.notices;
            if (!record) {
              if (opts.preserveCostHistory && r.type === 'finance-product-costs') {
                const raw = r.sourceCostRow;
                const productRef = (r.data.productId as LegacyRef)?.legacyRef;
                if (!opts.sourceRowsCrypto || !raw || String(raw.company_id) !== String(source.company.id) || String(raw.id) !== r.id || !productRef || productRef.type !== 'finance-products' || String(raw.product_id) !== productRef.id || !Number.isSafeInteger(data.productId)) throw new MigrationError('成本历史缺少可核对的原始行或商品关联');
                if (yuanToPreciseCents(String(raw.unit_cost)) !== data.unitCost || String(raw.effective_from) !== data.effectiveFrom || String(raw.effective_to ?? '') !== String(data.effectiveTo ?? '')) throw new MigrationError('成本历史金额或生效日期与原始行不一致');
                await preserveSourceRow(em, opts.sourceRowsCrypto, { companyId: company.id, sourceCompanyId: source.company.id, table: 'finance_product_archive_costs', key: r.id }, raw);
                record = await withCostHistory(em, { companyId: company.id, productId: data.productId as number }, () => resources.importRecord(em, user, r.type, data, r.status));
              } else if (opts.preserveLegacyStates && r.type === 'tax-profiles') {
                const raw = r.sourceTaxRow;
                const oldLicense = (r.data.licenseId as LegacyRef | undefined)?.legacyRef;
                if (!opts.sourceRowsCrypto || !raw || String(raw.id) !== r.id || String(raw.company_id) !== String(source.company.id) || (raw.license_id != null && (!oldLicense || oldLicense.type !== 'licenses' || String(raw.license_id) !== oldLicense.id)) || String(raw.taxpayer_name ?? '') !== String(data.taxpayerName ?? '') || (raw.tax_category && String(raw.tax_category) !== String(data.taxCategory ?? ''))) throw new MigrationError('旧税务资料原始行或关联证据不一致');
                const category = data.taxCategory ?? 'operation';
                const duplicates = data.licenseId == null ? [] : await resources.findWhere(em, company.id, 'tax-profiles', 'licenseId', data.licenseId as number);
                const duplicate = duplicates.some(t => (t.data.taxCategory ?? 'operation') === category);
                await preserveSourceRow(em, opts.sourceRowsCrypto, { companyId: company.id, sourceCompanyId: source.company.id, table: 'tax_profiles', key: r.id }, raw);
                const issue = { ...(raw.license_id == null && data.licenseId == null ? { missingLicense: true as const } : {}), ...(duplicate ? { duplicateLicenseId: data.licenseId as number, duplicateCategory: String(category) } : {}) };
                record = await withLegacyTax(em, company.id, issue, () => resources.importRecord(em, user, r.type, data, r.status));
                if (issue.missingLicense || duplicate) out.excluded.push({ type: 'tax-profiles.identity', id: r.id, reason: issue.missingLicense ? '旧未关联执照税务资料单独保留，未猜测执照，原始行已加密留档' : '旧执照合并产生的同类别多份税务资料分别保留，未合并或覆盖字段，原始行已加密留档' });
              } else if (opts.preserveLegacyStates && ['stores', 'phones'].includes(r.type) && r.status === 'abnormal' && !data.abnormalReason) {
                const raw = r.sourceAbnormalRow;
                if (!opts.sourceRowsCrypto || !raw || String(raw.company_id) !== String(source.company.id) || String(raw.id) !== r.id || raw.status !== 'abnormal' || String(raw.abnormal_reason ?? '').trim()) throw new MigrationError('旧异常状态缺少原始空原因记录，禁止伪造');
                await preserveSourceRow(em, opts.sourceRowsCrypto, { companyId: company.id, sourceCompanyId: source.company.id, table: r.type === 'stores' ? 'stores' : 'phone_numbers', key: r.id }, raw);
                record = await withMissingLegacyReason(em, { companyId: company.id, library: r.type === 'stores' ? 'store-abnormal-reasons' : 'phone-abnormal-reasons' }, () => resources.importRecord(em, user, r.type, data, r.status,registration));
              } else record = await resources.importRecord(em, user, r.type, data, r.status,registration);
              count('created', r.type); resourceCreated.add(record.id);
            }
            else count('reused', r.type);
            if(r.type==='finance-product-sources'&&r.sourceUpdatedAt){
              const stamp=new Date(r.sourceUpdatedAt.replace(' ','T')+'+08:00');
              if(!Number.isFinite(stamp.getTime()))throw new MigrationError('供货来源更新时间无效，不能判断当前来源');
              await em.update(ResourceRecord,{id:record.id,companyId:company.id},{data:{...record.data,legacySourceId:r.id}});
              sourceStamps.push({id:record.id,stamp});
            }
            await register(r.type, r.id, record.id);
          });
          if (Object.keys(deferred).length) backfills.push({r,patch:deferred});
          progress++;
        } catch (e) {
          if (e instanceof MissingRef) next.push(r);
          else out.failures.push({ type: r.type, id: r.id, reason: safeFailure(e) });
        } finally { delete q.data.legacyAliasName; delete q.data.legacyNotices; delete q.data.legacyLicenseLocationNotice; }
      }
      pending = next;
      if (!progress) break;
    }
    for (const r of pending) out.failures.push({ type: r.type, id: r.id, reason: '依赖资料未成功迁入：'+Object.entries(r.data).filter(([,v])=>(v as LegacyRef)?.legacyRef && !lookup((v as LegacyRef).legacyRef.type,(v as LegacyRef).legacyRef.id)).map(([k,v])=>k+'→'+(v as LegacyRef).legacyRef.type+':'+(v as LegacyRef).legacyRef.id).join('，') });
    for(const {r,patch} of backfills) for(const [field,value] of Object.entries(patch)) {
      try { await savepoint(async()=>resources.importPatch(em,user,r.type,required(r.type,r.id),resolve({[field]:value}))); }
      catch(e) { out.failures.push({type:r.type+'.'+field,id:r.id,reason:e instanceof MissingRef?'关联对象未迁入，主资料保留；该关联未写入':safeFailure(e)}); }
    }
    // updatedAt 是只读列（insert/update:false，由库的 ON UPDATE 维护），不能走 ORM 更新；
    // 必须在所有补字段之后用原生 SQL 写回旧库时间，否则会被“现在”覆盖，当前来源排序依据就丢了。
    for(const {id,stamp} of sourceStamps)await em.query('UPDATE resource_records SET updated_at=? WHERE id=? AND company_id=? AND type=?',[stamp,id,company.id,'finance-product-sources']);
    const createdProducts=out.mappings.filter(m=>m.type==='finance-products' && resourceCreated.has(m.targetId));
    for(const m of createdProducts){
      if(await resources.countWhere(em,company.id,'finance-product-sources','productId',m.targetId))await refreshFromSources(resources,em,user,m.targetId);
    }
    for(const m of createdProducts)await recomputeProduct(resources,em,user,m.targetId);
    if(createdProducts.length)for(const m of out.mappings.filter(m=>m.type==='finance-base-codes' && resourceCreated.has(m.targetId)))await resources.importPatch(em,user,m.type,m.targetId,{});
    if(opts.preserveLegacyStates){
      try{out.verified!['gift-alias-index-view']=await verifyGiftAliasIndex({em,resources,user,sourceCompanyId:source.company.id,lookup},(source.sourceRows??[]).filter(r=>r.table==='finance_product_gift_aliases').map(r=>r.row));}
      catch(e){out.failures.push({type:'gift-alias-index',id:'company',reason:e instanceof Error&&e.message.startsWith('旧赠品别名索引')?e.message:safeFailure(e)});}
    }
    if (source.sourceRows?.some(r => r.table === 'legacy_verification_reports')) await restoreBaseVerifications({ em, companyId: company.id, sourceCompanyId: source.company.id, lookup, createdIds: resourceCreated, savepoint, count, fail: (type, id, reason) => out.failures.push({ type, id, reason }) }, source);
    if (source.sourceRows?.some(r => r.table === 'legacy_verification_reports')) await restoreBundleVerifications({ em, companyId: company.id, sourceCompanyId: source.company.id, lookup, createdIds: resourceCreated, savepoint, count, fail: (type, id, reason) => out.failures.push({ type, id, reason }) }, source);
    // 文件上传仅在正式/隔离试迁apply时执行；试跑没有文件系统副作用。
    if (opts.apply) for (const r of source.records) {
      const recordId = lookup(r.type, r.id); if (!recordId) continue;
      for (const field of [...new Set((r.files ?? []).map((f) => f.field))]) {
        try {
          await savepoint(async () => {
            const record = await em.findOneByOrFail(ResourceRecord, { id: recordId, type: r.type, companyId: company.id });
            const fileIds: number[] = Array.isArray(record.data[field]) ? [...record.data[field] as number[]] : [];
            for (const f of r.files!.filter((f) => f.field === field)) {
              const fileKey = `${r.type}:${r.id}:${f.field}:${f.id}`;
              let fileId = lookup('file', fileKey);
              if (!fileId && f.contentHash && /^[0-9a-f]{64}$/.test(f.contentHash)) {
                // 同一合并资料、同一字段、相同摘要复用附件；保留每个来源文件对照。
                for(const other of source.records){
                  if(other.type!==r.type || lookup(other.type,other.id)!==recordId)continue;
                  const same=other.files?.find(x=>x.field===field&&x.contentHash===f.contentHash&&lookup('file',`${other.type}:${other.id}:${x.field}:${x.id}`));
                  if(same){fileId=lookup('file',`${other.type}:${other.id}:${same.field}:${same.id}`);break;}
                }
                if(fileId){await register('file',fileKey,fileId);count('reused','file');}
              }
              if (!fileId) {
                const buffer = await source.loadFile(f.locator);
                const info = await files.putBlob(company.id, actor.id, r.type, field, { originalname: f.name, buffer, size: buffer.length }, em);
                fileId = info.id; await register('file', fileKey, fileId); count('created', 'file');
              }
              if(!fileIds.includes(fileId))fileIds.push(fileId);
            }
            await resources.importPatch(em, user, r.type, record.id, { [field]: fileIds });
          });
        } catch (e) { out.failures.push({ type: `${r.type}.${field}`, id: r.id, reason: safeFailure(e) }); }
      }
    }

    if(opts.preserveLegacyStates){
      const resolvedDifferences=new Set<string>();
      for(const r of source.records.filter(r=>r.type==='bank-accounts')){
        try{
          const originals=source.sourceRows?.filter(row=>row.table==='bank_accounts'&&String(row.row.id)===r.id)??[];
          if(!opts.sourceRowsCrypto||originals.length!==1)throw new MigrationError('旧银行登记缺少原始行证据');
          const result=await savepoint(async()=>{
            const result=await importBankRegistration({em,resources,crypto:opts.sourceRowsCrypto!,user,sourceCompanyId:source.company.id,parentId:required(r.type,r.id),lookup},r.id,originals[0].row,resolve(r.data),Boolean(r.files?.length));
            const linked=lookup('bank-account-history',r.id);
            if(linked!=null&&linked!==result.id)throw new MigrationError('旧银行登记来源账本引用不一致');
            if(!linked)await register('bank-account-history',r.id,result.id);
            return result;
          });
          count(result.reused?'reused':'created','bank-account-history');out.verified??={};out.verified['bank-account-history-view']=(out.verified['bank-account-history-view']??0)+1;
          for(const field of ['kind','keeperUserId','reconcileCycle'])resolvedDifferences.add(`${r.id}:${field}`);
        }catch(e){out.failures.push({type:'bank-account-history',id:r.id,reason:e instanceof Error&&e.message.startsWith('旧银行登记')?e.message:safeFailure(e)});}
      }
      out.excluded=out.excluded.filter(e=>!e.type.startsWith('bank-accounts.duplicate.')||!resolvedDifferences.has(`${e.id}:${e.type.slice('bank-accounts.duplicate.'.length)}`));
    }

    if(opts.preserveLegacyStates){
      for(const record of source.records.filter(r=>r.type==='phones')){try{
        const original=await resources.legacySourceRow(em,user,source.company.id,'phone_numbers',record.id);
        if(!original)throw new MigrationError('旧号码充值核对缺少原始行');
        if(await verifyPhoneRechargeView({em,resources,user,sourceCompanyId:source.company.id,parentId:required(record.type,record.id)},record,original))out.verified!['phone-recharge-view']=(out.verified!['phone-recharge-view']??0)+1;
      }catch(e){out.failures.push({type:'phone-recharge-view',id:record.id,reason:safeFailure(e)});}}
      const groups=new Map<string,LegacyRecord[]>();
      for(const r of source.records.filter(r=>r.type==='phones')){const id=lookup(r.type,r.id),number=normalizePhone(String(r.data.number??''));if(id&&number)groups.set(number,[...(groups.get(number)??[]),r]);}
      for(const records of groups.values())if(records.length>1){
        try{
          const originals=records.map(record=>{const rows=source.sourceRows?.filter(row=>row.table==='phone_numbers'&&String(row.row.id)===record.id)??[];if(rows.length!==1)throw new MigrationError('旧号码登记缺少完整原始行');return {record,parentId:required(record.type,record.id),raw:rows[0].row,data:resolve(record.data)};});
          const result=await savepoint(async()=>{
            const rows=await importPhoneRegistrations({em,resources,user,sourceCompanyId:source.company.id,parentId:originals[0].parentId},originals);
            for(const row of rows){const id=lookup('phone-registration-history',row.sourceId);if(id!=null&&id!==row.id)throw new MigrationError('旧号码登记账本不一致');if(!id)await register('phone-registration-history',row.sourceId,row.id);}
            return rows;
          });
          for(const row of result){count(row.reused?'reused':'created','phone-registration-history');out.verified!['phone-registration-history-view']=(out.verified!['phone-registration-history-view']??0)+1;}
          const ids=new Set(records.map(r=>r.id));
          out.excluded=out.excluded.filter(e=>!ids.has(e.id)||!['certifiedName','plan','externalUser','deviceType','forwardApp','forwardAppName','rechargeDay','feeCycle','note'].some(field=>e.type==='phones.duplicate.'+field));
        }catch(e){out.failures.push({type:'phone-registration-history',id:records.map(r=>r.id).join(':'),reason:e instanceof Error&&e.message.startsWith('旧号码登记')?e.message:safeFailure(e)});}
      }
    }

    // 旧库手动关联（合作人⇄执照/店铺/银行、执照关联运营、手机号关联等）迁成新系统的手动关联，带用途与有效期。
    const skipLink = (l: { id: string; relation: string }, reason: string) => {
      const L = out.links; L.skipped++; L.skippedReasons[reason] = (L.skippedReasons[reason] ?? 0) + 1;
      (L.byRelation[l.relation] ??= { created: 0, skipped: 0 }).skipped++;
    };
    const carries = (rec: ResourceRecord, otherType: string, otherId: number) => {
      const def = getResourceDef(rec.type);
      return !!def?.fields.some((f) => (f.type === 'ref' && f.ref === otherType && rec.data[f.key] === otherId) || (f.type === 'refs' && f.ref === otherType && Array.isArray(rec.data[f.key]) && (rec.data[f.key] as unknown[]).includes(otherId)));
    };
    for (const l of source.links ?? []) {
      if (reuse('link', l.id)) { out.links.reused++; continue; }
      const sourceId = lookup(l.sourceType, l.sourceId), targetId = lookup(l.targetType, l.targetId);
      if (!sourceId || !targetId) { skipLink(l, '关联一端的资料未迁入（旧库已删除、失败或不在迁入范围）'); continue; }
      const toUser = l.targetType === 'user';
      if (!toUser && l.sourceType === l.targetType && sourceId === targetId) { skipLink(l, '关联指向自己'); continue; }
      const dup = await em.findOne(ResourceLink, { where: [
        { companyId: company.id, sourceType: l.sourceType, sourceId, targetType: l.targetType, targetId },
        ...(toUser ? [] : [{ companyId: company.id, sourceType: l.targetType, sourceId: targetId, targetType: l.sourceType, targetId: sourceId }]),
      ] });
      if (dup) { skipLink(l, '新系统已存在同一对象的关联（重复，保留先迁入的一条）'); continue; }
      const src = await em.findOne(ResourceRecord, { where: { id: sourceId, companyId: company.id, type: l.sourceType } });
      const tgt = toUser ? null : await em.findOne(ResourceRecord, { where: { id: targetId, companyId: company.id, type: l.targetType } });
      if (!src || (!toUser && !tgt)) { skipLink(l, '关联对象不属于目标公司或类型不符'); continue; }
      if (carries(src, l.targetType, targetId) || (tgt && carries(tgt, l.sourceType, sourceId))) { skipLink(l, '已由资料字段承载同一关联，不重复建手动关联'); continue; }
      const row = await em.save(ResourceLink, em.create(ResourceLink, { companyId: company.id, sourceType: l.sourceType, sourceId, relation: 'manual', targetType: l.targetType, targetId, validFrom: l.validFrom ?? null, validTo: l.validTo ?? null, purpose: l.purpose ? l.purpose.slice(0, 200) : null }));
      await register('link', l.id, row.id); count('created', 'link'); out.links.created++;
      (out.links.byRelation[l.relation] ??= { created: 0, skipped: 0 }).created++;
    }
    // 旧直播管理数据：依赖员工与位置/自媒体/店铺/基础编码资料，所以放在资料之后；每行一个保存点，失败只影响这一行
    if (source.live) await importLive({ em, companyId: company.id, actorId: actor.id, lookup, register, count, savepoint, safeFailure, fail: (type, id, reason) => out.failures.push({ type, id, reason }), note: (type, id, reason) => out.excluded.push({ type, id, reason }) }, source.live);
    for (const original of source.sourceRows?.filter(r => r.table === 'finance_entries') ?? []) {
      if (reuse('finance-ledger-history', original.key)) continue;
      try {
        await savepoint(async () => {
          if (!opts.sourceRowsCrypto) throw new MigrationError('旧收支记录缺少加密服务');
          const result = await importFinanceLedger({ em, crypto: opts.sourceRowsCrypto, resources, user, sourceCompanyId: source.company.id, lookup }, original.row);
          await register('finance-ledger-history', original.key, result.id);
          count(result.reused ? 'reused' : 'created', 'finance-ledger-history');
        });
      } catch (e) { out.failures.push({ type: 'finance-ledger-history', id: original.key, reason: safeFailure(e) }); }
    }
    if(opts.preserveLegacyStates){
      const boundPositions=Object.create(ds) as DataSource;Object.defineProperty(boundPositions,'manager',{value:em});
      out.verified!['employee-position-history-view']=await verifyEmployeePositionView(boundPositions,resources,user,source,lookup);
      const names=out.excluded.filter(e=>e.type==='position.name'),resolved=new Set<string>();
      const bound=Object.create(ds) as DataSource;Object.defineProperty(bound,'manager',{value:em});const org=new OrgAdminService(bound,resources);
      for(const note of names){try{
        const id=required('position',note.id),original=source.positions.find(p=>String(p.id)===note.id),view=await org.positionProfile(user,id);
        if(!original||view.legacyName?.name!==original.name)throw new MigrationError('原岗位名页面读取与来源不一致');
        resolved.add(note.id);out.verified!['position-original-name-view']=(out.verified!['position-original-name-view']??0)+1;
      }catch(e){out.failures.push({type:'position-original-name-view',id:note.id,reason:safeFailure(e)});}}
      out.excluded=out.excluded.filter(e=>e.type!=='position.name'||!resolved.has(e.id));
    }
    if (source.workflow) {
      if (!opts.sourceRowsCrypto) throw new MigrationError('流程历史导入必须提供目标库加密服务');
      await importWorkflows({ em, resources, crypto: opts.sourceRowsCrypto, companyId: company.id, actorId: actor.id, lookup, register, count, savepoint, safeFailure, verified:type=>{out.verified![type]=(out.verified![type]??0)+1;}, fail: (type, id, reason) => out.failures.push({ type, id, reason }), note: (type, id, reason) => out.excluded.push({ type, id, reason }) }, source, source.workflow);
    }
    // 旧库已归档的行：最后落成新系统的“已归档”（放在所有引用和文件写入之后，避免被“引用已归档”校验挡住）。
    for (const r of source.records) {
      if (!r.archive) continue;
      const id = lookup(r.type, r.id); if (!id || !resourceCreated.has(id)) continue;
      const policy = ARCHIVE_POLICY[r.type];
      if (!policy) { out.archived.skipped.push({ type: r.type, id: r.id, reason: '该资料类型在新系统没有归档策略，按普通记录迁入' }); continue; }
      try {
        await savepoint(async () => {
          const def = getResourceDef(r.type)!;
          const at = r.archive!.at ? new Date(r.archive!.at.replace(' ', 'T') + '+08:00') : new Date();
          if (!Number.isFinite(at.getTime())) throw new MigrationError('旧归档时间无效');
          const from = r.archive!.fromStatus && def.statuses.some((x) => x.value === r.archive!.fromStatus) ? r.archive!.fromStatus : null;
          const by = r.archive!.by ? lookup('user', r.archive!.by) ?? null : null;
          const changed = await em.update(ResourceRecord, { id, companyId: company.id, type: r.type }, { archivedAt: at, archivedBy: by, archiveReason: (r.archive!.reason?.trim() || '旧系统归档（原因未记录）').slice(0, 500), archivedFromStatus: from, status: policy.archivedStatus });
          if (!changed.affected) throw new MigrationError('归档写入未命中记录');
        });
        out.archived.total++; out.archived.byType[r.type] = (out.archived.byType[r.type] ?? 0) + 1;
        if (!r.archive.fromStatus || !getResourceDef(r.type)!.statuses.some((x) => x.value === r.archive!.fromStatus)) out.excluded.push({ type: r.type + '.archivedFromStatus', id: r.id, reason: '旧归档前状态缺失或在新系统无对应值，恢复时将使用该资料的默认状态' });
      } catch (e) { out.failures.push({ type: r.type + '.archive', id: r.id, reason: safeFailure(e) }); }
    }
    await em.update(Company, { id: company.id }, { name: source.company.name });
    if(opts.preserveLegacyStates){
      out.fieldCoverage=sourceFieldCoverage(source.sourceRows,out.verified??{},source.workflow);
      if(out.fieldCoverage?.totals.pendingColumns)out.excluded.push({type:'source-fields.pending',id:'all',reason:`本公司范围及未读取表共${out.fieldCoverage.totals.pendingColumns}个来源字段尚待原生/历史逐字段验收；原文已保留的部分详见fieldCoverage，不把保留原文当作原生可用`});
    }
    await em.insert(AuditLog, { companyId: company.id, actorId: actor.id, action: 'legacy.import', resourceType: 'company', resourceId: String(company.id), detail: { ...(opts.deferredScope?{deferredScope:opts.deferredScope}:{}),sourceCompanyId: source.company.id, created: out.created, reused: out.reused, failedCount: out.failures.length, excludedCount: out.excluded.length } });
    if(opts.expectedReport){
      const prior=opts.expectedReport;
      const nonFiles=(counts:Record<string,number>)=>Object.fromEntries(Object.entries(counts).filter(([k])=>k!=='file').sort(([a],[b])=>a.localeCompare(b)));
      const rowProblems=(r:ImportResult)=>r.failures.filter(f=>{const i=f.type.lastIndexOf('.');const file=i>0&&getResourceDef(f.type.slice(0,i))?.fields.find(x=>x.key===f.type.slice(i+1))?.type==='files';return !prior.phase.startsWith('dry-run')||!file;}).map(f=>[f.type,f.id,f.reason]).sort();
      if(prior.sourceFingerprint!==out.sourceFingerprint || JSON.stringify(nonFiles(prior.created))!==JSON.stringify(nonFiles(out.created)) || JSON.stringify(nonFiles(prior.reused))!==JSON.stringify(nonFiles(out.reused)) || JSON.stringify(nonFiles(prior.verified??{}))!==JSON.stringify(nonFiles(out.verified??{})) || JSON.stringify(stable(prior.fieldCoverage??null))!==JSON.stringify(stable(out.fieldCoverage??null)) || JSON.stringify(rowProblems(prior))!==JSON.stringify(rowProblems(out)) || JSON.stringify(prior.excluded.map(x=>[x.type,x.id,x.reason]).sort())!==JSON.stringify(out.excluded.map(x=>[x.type,x.id,x.reason]).sort())){out.phase=opts.apply?'apply-rejected-rollback':'dry-run-rejected-rollback';throw new MigrationError('本批结果与已核对试迁不一致，整批回滚');}
    }
    // Full remigration must account for skipped business data, not merely zero
    // insertion errors. Only these two notes already retain native data and
    // encrypted evidence. A rejected apply report must say rollback as well.
    const rejection = opts.apply && (source.workflow || opts.preserveLegacyStates) ? out.failures.length ? '流程续办或资料仍有失败，禁止正式写入，整批回滚' : out.excluded.some(e => !['licenses.locationId', 'tax-profiles.identity'].includes(e.type))&&!(external&&q.data.cutoverPrepareOnly===true)&&!deferredScopeMatches(opts.deferredScope,opts.expectedReport) ? '全量迁移仍有未验收排除项或历史数据，禁止正式写入，整批回滚' : null : null;
    if (rejection) out.phase = 'apply-rejected-rollback';
    opts.prepareReport?.(out);
    if (rejection) throw new MigrationError(rejection);
    if(external)out.phase='prepared; outer transaction not committed';
    else if (opts.apply) await q.commitTransaction(); else await q.rollbackTransaction();
    return out;
  } catch (e) { if (!external&&q.isTransactionActive) await q.rollbackTransaction();
    if (!external&&q.data.importUploadedKeys?.length) await files.deleteObjects(opts.companyId, q.data.importUploadedKeys);
    // SQL rollback is confirmed here. Object deletion is best effort in the
    // storage service and must be independently checked by the cutover runner.
    if(['apply-rejected-rollback','dry-run-rejected-rollback'].includes(out.phase))opts.rollbackReport?.(out);
    throw e; }
  finally { if(!external)await q.release(); }
}
