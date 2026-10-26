import { mapLegacyPermission } from './permissions';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Company, Department, Position, User, PlatformAdmin, PositionPermission, UserPermissionOverride, ResourceRecord, ResourceFile, AuditLog } from '../entities';
import { refreshFromSources, recomputeProduct } from '../resources/finance-rules';
import { ResourcesService } from '../resources/resources.service';
import { FilesService } from '../integrations/files.service';
import { AuthUser } from '../common/auth.decorators';
import { yuanToPreciseCents, normalizePhone, getResourceDef } from '@kudesi/shared';
import { encodeLegacyPassword } from '../auth/password';
import { aliasCode } from '../resources/base-code-support';
import { LegacyArchive, LegacyRecord, LegacyRef } from './protocol';

const SOURCE = 'legacy-oa';
function stable(v: unknown): unknown {
  if(Array.isArray(v)) return v.map(stable);
  if(v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='locator').sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)]));
  return v;
}
export interface ImportResult { sourceFingerprint: string; phase: string; companyId: number; created: Record<string, number>; reused: Record<string, number>; excluded: Array<{ type: string; id: string; reason: string }>; failures: Array<{ type: string; id: string; reason: string }>; mappings: Array<{ type: string; sourceId: string; targetId: number }> }
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
  const out: ImportResult = { sourceFingerprint:'', phase: opts.apply ? 'apply' : 'dry-run-rollback', companyId: opts.companyId, created: {}, reused: {}, excluded: [...source.exclusions], failures: [], mappings: [] };
  const ids = new Map<string, number>();
  const hashes = new Map<string,string>();
  const orgCreated=new Set<string>();
  const resourceCreated=new Set<number>();
  const key = (type: string, id: unknown) => `${type}:${String(id)}`;
  for(const [type,rows] of [['department',source.departments],['position',source.positions],['user',source.employees],...['resource'].map(t=>[t,source.records])] as Array<[string,Array<Record<string,any>>]>) {
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
      const entity = l.target_type === 'user' ? User : l.target_type === 'department' ? Department : l.target_type === 'position' ? Position : l.target_type === 'file' ? ResourceFile : ResourceRecord;
      const exists = await em.findOne(entity as typeof User, { where: { id: l.target_id, companyId: company.id } });
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
      const workspace = ['boss','general','operations','finance','cashier','warehouse','purchasing','support','blank'].includes(p.workspace_template_key) ? p.workspace_template_key : 'blank';
      if (!p.name || String(p.name).length > 100 || !['boss','manager','staff'].includes(p.level)) throw new MigrationError('岗位名称或显式层级待核定');
      let positionName = String(p.name);
      if (await em.findOneBy(Position, { companyId: company.id, name: positionName })) {
        const departmentName = source.departments.find(d => String(d.id) === String(p.department_id))?.name;
        positionName = `${departmentName} / ${p.name}`;
        if (await em.findOneBy(Position, { companyId: company.id, name: positionName })) positionName += `（旧ID ${p.id}）`;
        if (positionName.length > 100) throw new MigrationError('同名岗位区分名称超长');
        out.excluded.push({ type: 'position.name', id: String(p.id), reason: '旧岗位名与目标公司岗位重名，使用来源部门名加岗位名区分；保留旧新ID对照' });
      }
      const r = await em.save(Position, em.create(Position, { companyId: company.id, departmentId: required('department', p.department_id), name: positionName, workspaceType: workspace, level: p.level, supervisorPositionId: null, description: p.description, status: p.status === 'active' ? 'active' : 'inactive' }));
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
      const r = await em.save(User, em.create(User, { companyId: company.id, account, passwordHash: account ? encodeLegacyPassword(String(e.password_salt), String(e.password_hash)) : '!no-login', name: e.name, departmentId: required('department', e.department_id), positionId: primary ? required('position', primary.position_id) : null, extraPositionIds: positions.filter((x) => x !== primary).map((x) => required('position', x.position_id)), managerId: null, title: e.title || null, baseSalary: e.base_salary===null||e.base_salary===undefined?null:yuanToPreciseCents(String(e.base_salary),0), isCompanyAdmin: ['admin','company_admin','boss'].includes(e.role_key), status: e.status === 'active' ? 'active' : 'disabled', mustChangePassword: false }));
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
    const backfills: Array<{r:LegacyRecord; patch:Record<string,unknown>}> = [];
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
          const structural = new Set(['parentId','canonicalId','productId','componentId','baseCodeId','laborId','schemeId','versionId','branchId','carrierId','supplierId','categoryId','bundleId']);
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
              await em.update(ResourceRecord,{id:record.id,companyId:company.id},{updatedAt:stamp,data:{...record.data,legacySourceId:r.id}});
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
