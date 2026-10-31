import { mapLegacyPermission } from './permissions';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
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

const SOURCE = 'legacy-oa';
function stable(v: unknown): unknown {
  if(Array.isArray(v)) return v.map(stable);
  if(v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='locator').sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)]));
  return v;
}
export interface ImportResult { sourceFingerprint: string; phase: string; companyId: number; created: Record<string, number>; reused: Record<string, number>; excluded: Array<{ type: string; id: string; reason: string }>; failures: Array<{ type: string; id: string; reason: string }>; mappings: Array<{ type: string; sourceId: string; targetId: number }>; archived: { total: number; byType: Record<string, number>; skipped: Array<{ type: string; id: string; reason: string }> }; links: { created: number; reused: number; skipped: number; skippedReasons: Record<string, number>; byRelation: Record<string, { created: number; skipped: number }> } }
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
export async function runLegacyImport(ds: DataSource, resources: ResourcesService, files: FilesService, source: LegacyArchive, opts: { companyId: number; actorId: number; expectedName: string; apply: boolean; expectedReport?: ImportResult; prepareReport?: (result:ImportResult)=>void }): Promise<ImportResult> {
  for(const [rows,parent] of [[source.departments,'parent_department_id'],[source.positions,'supervisor_position_id'],[source.employees,'manager_id']] as Array<[Array<Record<string,any>>,string]>) {
    const parents=new Map(rows.map(r=>[String(r.id),r[parent]?String(r[parent]):null]));
    for(const r of rows){const seen=new Set<string>();let id:string|null=String(r.id);while(id){if(seen.has(id))throw new MigrationError('来源组织引用存在循环，不能直接迁入');seen.add(id);id=parents.get(id)??null;}}
  }
  const q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
  q.data.legacyImport = true;
  const em = q.manager;
  const out: ImportResult = { sourceFingerprint:'', phase: opts.apply ? 'apply' : 'dry-run-rollback', companyId: opts.companyId, created: {}, reused: {}, excluded: [...source.exclusions], failures: [], mappings: [], archived: { total: 0, byType: {}, skipped: [] }, links: { created: 0, reused: 0, skipped: 0, skippedReasons: {}, byRelation: {} } };
  const ids = new Map<string, number>();
  const hashes = new Map<string,string>();
  const orgCreated=new Set<string>();
  const resourceCreated=new Set<number>();
  const key = (type: string, id: unknown) => `${type}:${String(id)}`;
  for(const [type,rows] of [['department',source.departments],['position',source.positions],['user',source.employees],['position_duty',source.positionDuties??[]],['comp_record',source.compensationRecords??[]],...['resource'].map(t=>[t,source.records]),['link',source.links??[]],...liveHashGroups(source.live)] as Array<[string,Array<Record<string,any>>]>) {
    for(const r of rows) hashes.set(key(type==='resource'?r.type:type,r.id),createHash('sha256').update(JSON.stringify(stable(r))).digest('hex'));
  }
  out.sourceFingerprint=createHash('sha256').update(JSON.stringify(stable({hashes:[...hashes].sort(([a],[b])=>a.localeCompare(b)),company:source.company,employeePositions:source.employeePositions,positionPermissions:source.positionPermissions,employeeOverrides:source.employeeOverrides??[]}))).digest('hex');
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
    const prior = { ids: new Map(ids), created: { ...out.created }, reused: { ...out.reused }, mappings: out.mappings.length, uploaded: (q.data.importUploadedKeys ?? []).length };
    try { const r = await fn(); await em.query(`RELEASE SAVEPOINT ${name}`); return r; }
    catch (e) { await em.query(`ROLLBACK TO SAVEPOINT ${name}`); await em.query(`RELEASE SAVEPOINT ${name}`);
      ids.clear(); for (const [k,v] of prior.ids) ids.set(k,v);
      out.created = prior.created; out.reused = prior.reused; out.mappings.length = prior.mappings;
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
    if (company.name !== opts.expectedName && company.name !== source.company.name) throw new MigrationError('目标公司名与核对条件不符');
    const actor = await em.findOneByOrFail(User, { id: opts.actorId, companyId: opts.companyId, isCompanyAdmin: true, status: 'active' });
    const user: AuthUser = { id: actor.id, companyId: company.id, name: actor.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const oldLinks: Array<{ source_key: string; target_type: string; target_id: number; source_hash: string }> = await em.query('SELECT source_key,target_type,target_id,source_hash FROM legacy_import_links WHERE source_system=? AND source_company_id=? AND company_id=?', [SOURCE, source.company.id, company.id]);
    for (const l of oldLinks) {
      if(hashes.has(l.source_key) && hashes.get(l.source_key)!==l.source_hash) throw new MigrationError('来源资料已变化，禁止复跑静默复用或覆盖；请先核对增量');
      if (LIVE_TARGET_TABLE[l.target_type]) {
        const [row] = await em.query(`SELECT id FROM ${LIVE_TARGET_TABLE[l.target_type]} WHERE id = ? AND company_id = ?`, [l.target_id, company.id]);
        if (!row) throw new MigrationError('迁移账本引用已失效，必须先核对，不能自动补造');
        ids.set(l.source_key, Number(l.target_id)); continue;
      }
      const entity = l.target_type === 'user' ? User : l.target_type === 'department' ? Department : l.target_type === 'position' ? Position : l.target_type === 'position_duty' ? PositionDuty : l.target_type === 'comp_record' ? EmployeeCompensationRecord : l.target_type === 'file' ? ResourceFile : l.target_type === 'link' ? ResourceLink : ResourceRecord;
      const exists = await em.findOne(entity as typeof User, { where: { id: l.target_id, companyId: company.id } });
      if (!exists && l.target_type === 'link') { ids.set(l.source_key, Number(l.target_id)); continue; } // 手动关联被人工取消后，复跑不重建
      if (!exists) throw new MigrationError('迁移账本引用已失效，必须先核对，不能自动补造');
      ids.set(l.source_key, Number(l.target_id));
    }
    // 部门、岗位先建立实体，再回填父级；来源孤立引用直接中止组织批次。
    for (const d of source.departments) {
      if (reuse('department', d.id)) continue;
      if (!d.name || String(d.name).length > 100) throw new MigrationError('部门名称不合法');
      const r = await em.save(Department, em.create(Department, { companyId: company.id, name: d.name, parentId: null, sortOrder: Number(d.sort_order || 0), status: d.status === 'active' ? 'active' : 'inactive' }));
      await register('department', d.id, r.id); count('created', 'department'); orgCreated.add(key('department', d.id));
    }
    for (const d of source.departments) if (orgCreated.has(key('department',d.id)) && d.parent_department_id) await em.update(Department, { id: required('department', d.id), companyId: company.id }, { parentId: required('department', d.parent_department_id) });
    for (const p of source.positions) {
      if (reuse('position', p.id)) continue;
      const workspace = workspaceTypeFromLegacyTemplate(p.workspace_template_key) ?? 'blank';
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
      if (workspace === 'blank') out.excluded.push({ type: 'position.workspaceType', id: String(p.id), reason: '旧岗位未提供新系统支持的显式工作台类型，保留空白，不按名称猜测' });
    }
    for (const p of source.positions) if (orgCreated.has(key('position',p.id)) && p.supervisor_position_id) await em.update(Position, { id: required('position', p.id), companyId: company.id }, { supervisorPositionId: required('position', p.supervisor_position_id) });
    for (const e of source.employees) {
      if (reuse('user', e.id)) continue;
      const account = String(e.login_account ?? '').trim() || null;
      if (!e.name || String(e.name).length > 50 || (account && account.length > 64)) throw new MigrationError('员工姓名或账号长度不适配');
      if (account && (await em.findOneBy(User, { account }) || await em.findOneBy(PlatformAdmin, { account }))) throw new MigrationError('员工账号与目标系统已有账号冲突，禁止覆盖');
      const positions = source.employeePositions.filter((x) => String(x.employee_id) === String(e.id));
      const primary = positions.find((x) => x.is_primary) ?? positions[0];
      const r = await em.save(User, em.create(User, { companyId: company.id, account, passwordHash: account ? encodeLegacyPassword(String(e.password_salt), String(e.password_hash)) : '!no-login', name: e.name, departmentId: required('department', e.department_id), positionId: primary ? required('position', primary.position_id) : null, extraPositionIds: positions.filter((x) => x !== primary).map((x) => required('position', x.position_id)), managerId: null, title: e.title || null, baseSalary: e.base_salary===null||e.base_salary===undefined?null:yuanToPreciseCents(String(e.base_salary),0), payType: e.pay_type==='hourly'?'hourly':'monthly', hourlyRate: e.hourly_rate===null||e.hourly_rate===undefined?null:yuanToPreciseCents(String(e.hourly_rate),0), employmentType: ['part_time','temp'].includes(e.employment_type)?e.employment_type:'regular', isCompanyAdmin: ['admin','company_admin','boss'].includes(e.role_key), status: e.status === 'active' ? 'active' : 'disabled', mustChangePassword: false }));
      await register('user', e.id, r.id); count('created', 'user'); orgCreated.add(key('user', e.id));
    }
    for (const e of source.employees) if (orgCreated.has(key('user',e.id)) && e.manager_id) await em.update(User, { id: required('user', e.id), companyId: company.id }, { managerId: required('user', e.manager_id) });
    for (const p of source.positionPermissions) {
      if(!orgCreated.has(key('position',p.position_id)))continue;
      const oldPermission = p.permission_key ?? p.permission;
      const permission = mapLegacyPermission(oldPermission);
      if (!permission) { out.excluded.push({ type: 'position.permission', id: `${p.position_id}:${oldPermission}`, reason: '旧权限没有明确的新功能对应，未扩大授权' }); continue; }
      const positionId = required('position', p.position_id);
      if (!await em.findOneBy(PositionPermission, { positionId, permission })) await em.insert(PositionPermission, { positionId, permission });
    }
    for(const override of source.employeeOverrides ?? []) {
      if(!orgCreated.has(key('user',override.employee_id)))continue;
      const permission=mapLegacyPermission(override.permission_key);
      if(!permission) {out.excluded.push({type:'user.permission',id:String(override.id),reason:'旧个人权限没有明确的新权限对应，未扩大授权'});continue;}
      const userId=required('user',override.employee_id);
      if(!['allow','deny'].includes(override.effect))throw new MigrationError('旧个人权限效果不合法');
      if(!await em.findOneBy(UserPermissionOverride,{userId,permission})) await em.insert(UserPermissionOverride,{userId,permission,effect:override.effect});
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
    let pending = source.records.slice();
    // 按引用依赖排序；依赖失败的记录不会写坏引用。每条失败回滚它产生的全部联动。
    for (let pass = 0; pending.length && pass < 100; pass++) {
      const next: LegacyRecord[] = []; let progress = 0;
      for (const r of pending) {
        if (reuse(r.type, r.id)) { progress++; continue; }
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
          await savepoint(async () => {
            const def = getResourceDef(r.type);
            if (!def) throw new MigrationError('目标资料类型不存在');
            let record: ResourceRecord | null = null;
            if (['finance-platforms','finance-scenarios'].includes(r.type) && def.uniqueField) {
              const v = data[def.uniqueField];
              record = typeof v === 'string' ? await resources.findByUnique(em, company.id, r.type, v.toLowerCase()) : null;
              if (record && Object.entries(data).some(([k, v]) => record!.data[k] !== v && !['note','sortOrder'].includes(k))) throw new MigrationError('目标已有字典值不同，禁止覆盖');
            }
            if (!record && def.uniqueField) {
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
            q.data.legacyAliasName = r.aliasName; q.data.legacyNotices = r.notices;
            if (!record) { record = await resources.importRecord(em, user, r.type, data, r.status); count('created', r.type); resourceCreated.add(record.id); }
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
        } finally { delete q.data.legacyAliasName; delete q.data.legacyNotices; }
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
    await em.insert(AuditLog, { companyId: company.id, actorId: actor.id, action: 'legacy.import', resourceType: 'company', resourceId: String(company.id), detail: { sourceCompanyId: source.company.id, created: out.created, reused: out.reused, failedCount: out.failures.length, excludedCount: out.excluded.length } });
    if(opts.expectedReport){
      const prior=opts.expectedReport;
      const nonFiles=(counts:Record<string,number>)=>Object.fromEntries(Object.entries(counts).filter(([k])=>k!=='file').sort(([a],[b])=>a.localeCompare(b)));
      const rowProblems=(r:ImportResult)=>r.failures.filter(f=>{const i=f.type.lastIndexOf('.');const file=i>0&&getResourceDef(f.type.slice(0,i))?.fields.find(x=>x.key===f.type.slice(i+1))?.type==='files';return !prior.phase.startsWith('dry-run')||!file;}).map(f=>[f.type,f.id,f.reason]).sort();
      if(prior.sourceFingerprint!==out.sourceFingerprint || JSON.stringify(nonFiles(prior.created))!==JSON.stringify(nonFiles(out.created)) || JSON.stringify(nonFiles(prior.reused))!==JSON.stringify(nonFiles(out.reused)) || JSON.stringify(rowProblems(prior))!==JSON.stringify(rowProblems(out))) throw new MigrationError('本批结果与已核对试迁不一致，整批回滚');
    }
    opts.prepareReport?.(out);
    if (opts.apply) await q.commitTransaction(); else await q.rollbackTransaction();
    return out;
  } catch (e) { if (q.isTransactionActive) await q.rollbackTransaction();
    if (q.data.importUploadedKeys?.length) await files.deleteObjects(opts.companyId, q.data.importUploadedKeys);
    throw e; }
  finally { await q.release(); }
}
