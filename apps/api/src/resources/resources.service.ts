import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm';
import {
  unitYuanText, yuanToPreciseCents, createChecker,
  addDaysText, daysBetweenDates, dueDateFor, expirySources, EXPIRY_SKIP_STATUSES, todayShanghai,
  FieldDef,
  getResourceDef,
  isTreeResource,
  treeFilterField,
  SIMILARITY_RESOURCES,
  inspectArchiveSimilarity,
  formatSimilarityMatch,
  normalizePhone,
  permissionOwner,
  RESOURCE_DEFS,
  ResourceDef,
  archivePolicyOf,
  resourcePermission,
  readOnlyFieldKeys,
  restrictedFieldKeys,
  validateResourceInput,
  validateStatusChange,
  normalizePhoneImportText,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { AuditLog, Department, ResourceChangeLog, ResourceImportBackup, ResourceLink, ResourceRecord, User } from '../entities';
import { FileInfo, FilesService } from '../integrations/files.service';
import { applyViewFilter, bindPhoneStores, derivePhoneFields, isViewFilter, mapLicenseByCreditCode } from './account-views';
import { afterCreateRule, afterDeleteRule, afterSaveRule, beforeDeleteRule, beforeSaveRule, RuleHost } from './resource-rules';

export interface ResourceDto {
  id: number;
  type: string;
  title: string;
  status: string;
  statusReason: string | null;
  /** 已归档时的信息（归档时间/原因/操作人）；未归档为 null */
  archived: { at: Date; reason: string | null; by: number | null; fromStatus: string | null } | null;
  /** 字段值：敏感字段是脱敏值，密码类字段不出现 */
  data: Record<string, unknown>;
  /** 密码/证件号类字段是否已设置 */
  secretConfigured: Record<string, boolean>;
  /** 引用字段 → 显示名 */
  refLabels: Record<string, string>;
  /** 文件字段里的文件信息（文件 id → 名称/类型/大小） */
  files: Record<number, FileInfo>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListQuery {
  /** true=只看已归档；默认不含已归档 */
  archived?: boolean;
  /** true=只看即将到期/已过期的（30 天内，规则见 shared/expiry.ts） */
  expiring?: boolean;
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: string;
  tab?: string;
  showHidden?: boolean;
  fieldKey?: string;
  fieldValue?: string;
  /** 多个字段筛选：JSON 对象 {字段: 值}；分类字段会包含下级分类 */
  filters?: string;
  /** 按这个字段排序（文本/数字/金额/日期/选项字段）；不传用默认顺序 */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  /** 只要这些记录（导出所选等） */
  ids?: number[];
}

const MAX_IMPORT_ROWS = 2000;
class Rollback extends Error {}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toUniqueKey(def: ResourceDef, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const field = def.fields.find((f) => f.key === def.uniqueField);
  const s = String(value).trim();
  return field?.type === 'phone' ? normalizePhone(s) : s.toLowerCase();
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

@Injectable()
export class ResourcesService implements RuleHost {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly crypto: CryptoService,
    private readonly files: FilesService,
  ) {}

  // ---------- 通用工具 ----------

  private def(type: string): ResourceDef {
    const def = getResourceDef(type);
    if (!def) throw new NotFoundException('没有这种资料');
    return def;
  }

  private uniqueKeyOf(def: ResourceDef, value: unknown): string | null {
    const key = toUniqueKey(def, value);
    return key && def.fields.find(f => f.key === def.uniqueField)?.type === 'sensitive' ? this.crypto.indexTokens(key)[0] : key;
  }

  private readSecrets(record: ResourceRecord): Record<string, string> {
    if (!record.secrets) return {};
    try {
      return JSON.parse(record.secrets) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async load(em: EntityManager, user: AuthUser, type: string, id: number): Promise<ResourceRecord> {
    const record = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type } });
    if (!record) throw new NotFoundException('记录不存在');
    return record;
  }

  /** 把引用字段解析成显示名（批量查询，避免逐条查）。 */
  private async refLabelsFor(
    em: EntityManager,
    companyId: number,
    def: ResourceDef,
    records: ResourceRecord[],
  ): Promise<Map<number, Record<string, string>>> {
    const refFields = def.fields.filter((f) => f.type === 'ref' || f.type === 'refs');
    const wanted = new Map<string, Set<number>>();
    for (const r of records) {
      for (const f of refFields) {
        const v = r.data[f.key];
        for (const one of f.type === 'refs' ? (Array.isArray(v) ? v : []) : [v]) {
          if (typeof one !== 'number') continue;
          if (!wanted.has(f.ref!)) wanted.set(f.ref!, new Set());
          wanted.get(f.ref!)!.add(one);
        }
      }
    }
    const names = new Map<string, Map<number, string>>();
    for (const [target, ids] of wanted) {
      const list = [...ids];
      const map = new Map<number, string>();
      if (target === 'user') {
        const users = await em
          .createQueryBuilder(User, 'u')
          .select(['u.id', 'u.name'])
          .where('u.companyId = :companyId AND u.id IN (:...list)', { companyId, list })
          .getMany();
        users.forEach((u) => map.set(u.id, u.name));
      } else if (target === 'department') {
        (await em.find(Department, { where: { companyId, id: In(list) } })).forEach((d) => map.set(d.id, d.name));
      } else {
        if (isTreeResource(target)) {
          // 树形资料（各种分类）显示完整路径：一级 / 二级 / 三级
          const paths = await this.treePaths(em, companyId, target);
          list.forEach((id) => { const p = paths.get(id); if (p) map.set(id, p); });
        } else {
          const rows = await em
            .createQueryBuilder(ResourceRecord, 'r')
            .select(['r.id', 'r.title'])
            .where('r.companyId = :companyId AND r.type = :target AND r.id IN (:...list)', { companyId, target, list })
            .getMany();
          rows.forEach((r) => map.set(r.id, r.title));
        }
      }
      names.set(target, map);
    }
    const out = new Map<number, Record<string, string>>();
    for (const r of records) {
      const labels: Record<string, string> = {};
      for (const f of refFields) {
        const v = r.data[f.key];
        if (f.type === 'refs') {
          if (Array.isArray(v) && v.length) labels[f.key] = v.map((x) => names.get(f.ref!)?.get(x as number) ?? `#${x}（已不存在）`).join('、');
        } else if (typeof v === 'number') labels[f.key] = names.get(f.ref!)?.get(v) ?? `#${v}（已不存在）`;
      }
      out.set(r.id, labels);
    }
    return out;
  }

  /** 树形资料每个节点的完整路径（顶层到本级，用 “ / ” 连接）。 */
  private async treePaths(em: EntityManager, companyId: number, target: string): Promise<Map<number, string>> {
    const rows = await em.find(ResourceRecord, { where: { companyId, type: target }, select: ['id', 'title', 'data'] });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out = new Map<number, string>();
    for (const r of rows) {
      const names = [r.title];
      let cur = r;
      for (let i = 0; i < 8; i++) {
        const pid = Number((cur.data as Record<string, unknown>)?.parentId);
        const up = pid ? byId.get(pid) : undefined;
        if (!up || up === r) break;
        names.unshift(up.title);
        cur = up;
      }
      out.set(r.id, names.join(' / '));
    }
    return out;
  }

  private toDto(def: ResourceDef, r: ResourceRecord, labels: Record<string, string>, fileMap: Map<number, FileInfo>): ResourceDto {
    const secrets = this.readSecrets(r);
    const data: Record<string, unknown> = { ...r.data };
    const secretConfigured: Record<string, boolean> = {};
    for (const f of def.fields) {
      if (f.type === 'secret') {
        delete data[f.key];
        secretConfigured[f.key] = Boolean(secrets[f.key]);
      } else if (f.type === 'sensitive') {
        // 证件号/银行卡号：对有查看权限的人明文显示（库里仍是加密存放）
        secretConfigured[f.key] = Boolean(secrets[f.key]);
        if (secrets[f.key]) {
          try {
            data[f.key] = this.crypto.decrypt(secrets[f.key]);
          } catch {
            data[f.key] = '';
          }
        }
      }
    }
    return {
      id: r.id,
      type: r.type,
      title: r.title,
      status: r.status,
      statusReason: r.statusReason,
      archived: r.archivedAt ? { at: r.archivedAt, reason: r.archiveReason, by: r.archivedBy, fromStatus: r.archivedFromStatus } : null,
      data,
      secretConfigured,
      refLabels: labels,
      files: Object.fromEntries(
        def.fields
          .filter((f) => f.type === 'files')
          .flatMap((f) => (Array.isArray(r.data[f.key]) ? (r.data[f.key] as number[]) : []))
          .filter((id) => fileMap.has(id))
          .map((id) => [id, fileMap.get(id)!]),
      ),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private async toDtos(em: EntityManager, user: AuthUser, def: ResourceDef, records: ResourceRecord[]) {
    const companyId = user.companyId;
    const restricted = restrictedFieldKeys(def, createChecker(user.permissions));
    const labels = await this.refLabelsFor(em, companyId, def, records);
    const fileIds = records.flatMap((r) =>
      def.fields.filter((f) => f.type === 'files').flatMap((f) => (Array.isArray(r.data[f.key]) ? (r.data[f.key] as number[]) : [])),
    );
    const fileMap = await this.files.info(companyId, fileIds);
    // 手机号的“绑定店铺 / 主子卡”：读时从店铺档案和主卡字段算，不存库
    const derived = def.key === 'phones' ? await derivePhoneFields(em, companyId, records, (r) => labels.get(r.id)?.parentPhoneId) : null;
    return records.map((r) => {
      const dto = this.toDto(def, r, labels.get(r.id) ?? {}, fileMap);
      if (derived) for (const [k, v] of Object.entries(derived.get(r.id) ?? {})) if (v !== undefined) dto.data[k] = v;
      // 成本等受限字段：没有权限的人，接口里就没有（不是前端隐藏）
      for (const k of restricted) {
        delete dto.data[k];
        delete dto.refLabels[k];
        delete dto.secretConfigured[k];
      }
      return dto;
    });
  }

  /** 日志里只留非敏感内容：密码类字段不进入，证件号等只有脱敏值。 */
  private logSafe(def: ResourceDef, r: ResourceRecord | null): Record<string, unknown> | null {
    if (!r) return null;
    const data = { ...r.data };
    for (const f of def.fields) if (f.type === 'secret') delete data[f.key];
    return { title: r.title, status: r.status, ...data };
  }

  private async writeLog(
    em: EntityManager,
    user: AuthUser,
    def: ResourceDef,
    id: number,
    action: string,
    before: ResourceRecord | null,
    after: ResourceRecord | null,
    note?: string,
  ) {
    await em.insert(ResourceChangeLog, {
      companyId: user.companyId,
      resourceType: def.key,
      resourceId: id,
      action,
      actorId: user.id,
      beforeJson: this.logSafe(def, before) as never,
      afterJson: this.logSafe(def, after) as never,
      note: note ?? null,
    });
  }

  // ---------- 保存（新建/修改共用） ----------

  /** 校验引用：目标必须属于同一家公司；员工必须在职（仅在新设置或变更时检查）；自引用不能成环。 */
  private async checkRefs(
    em: EntityManager,
    user: AuthUser,
    def: ResourceDef,
    data: Record<string, unknown>,
    existing: ResourceRecord | null,
  ) {
    for (const f of def.fields) {
      if (f.type === 'refs') {
        const list = Array.isArray(data[f.key]) ? (data[f.key] as number[]) : [];
        if (list.length) {
          const found = await em.count(ResourceRecord, { where: { id: In(list), companyId: user.companyId, type: f.ref! } });
          if (found !== list.length) throw new BadRequestException(`${f.label}：引用的记录不存在`);
          const before = Array.isArray(existing?.data[f.key]) ? (existing!.data[f.key] as number[]) : [];
          const added = list.filter((x) => !before.includes(x));
          if (added.length && (await em.count(ResourceRecord, { where: { id: In(added), companyId: user.companyId, archivedAt: Not(IsNull()) } })))
            throw new BadRequestException(`${f.label}：引用的记录已归档，请先恢复`);
        }
        continue;
      }
      if (f.type !== 'ref') continue;
      const value = data[f.key];
      if (typeof value !== 'number') continue;
      const changed = !existing || existing.data[f.key] !== value;
      if (f.ref === 'user') {
        const u = await em.findOne(User, { where: { id: value, companyId: user.companyId } });
        if (!u) throw new BadRequestException(`${f.label}：员工不存在`);
        if (changed && u.status !== 'active' && !em.queryRunner?.data.legacyImport) throw new BadRequestException(`${f.label}：只能选在职员工（${u.name} 已停用）`);
        continue;
      }
      if (f.ref === 'department') {
        if (!(await em.findOne(Department, { where: { id: value, companyId: user.companyId } }))) throw new BadRequestException(`${f.label}：部门不存在`);
        continue;
      }
      const target = await em.findOne(ResourceRecord, { where: { id: value, companyId: user.companyId, type: f.ref! } });
      if (!target) throw new BadRequestException(`${f.label}：引用的记录不存在`);
      if (target.archivedAt && changed) throw new BadRequestException(`${f.label}：「${target.title}」已归档，请先恢复`);
      if (f.ref === def.key) {
        if (existing && value === existing.id) throw new BadRequestException(`${f.label}不能选自己`);
        // 沿上级链往上走，遇到自己就是成环
        let cursor: ResourceRecord | null = target;
        for (let depth = 0; cursor && depth < 50; depth++) {
          const parent: unknown = cursor.data[f.key];
          if (typeof parent !== 'number') break;
          if (existing && parent === existing.id) throw new BadRequestException(`${f.label}不能形成循环`);
          cursor = await em.findOne(ResourceRecord, { where: { id: parent, companyId: user.companyId, type: def.key } });
        }
      }
    }
  }

  private async checkUniqueTogether(
    em: EntityManager,
    user: AuthUser,
    def: ResourceDef,
    data: Record<string, unknown>,
    existing: ResourceRecord | null,
  ) {
    for (const rule of def.uniqueTogether ?? []) {
      const values = rule.fields.map((k) => data[k]);
      if (values.some((v) => v === undefined || v === null || v === '')) continue;
      const rows = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: def.key }, select: ['id', 'data'] });
      const clash = rows.some((row) => row.id !== existing?.id && rule.fields.every((k, i) => sameJson(row.data[k], values[i])));
      if (clash) throw new ConflictException(rule.message);
    }
  }

  private buildSearchText(def: ResourceDef, data: Record<string, unknown>, title: string): string {
    const parts = [title];
    for (const f of def.fields) {
      if (f.search && f.type !== 'secret' && f.type !== 'sensitive' && f.type !== 'attrs' && data[f.key] != null) parts.push(String(data[f.key]));
    }
    return parts.join(' ').toLowerCase().slice(0, 1500);
  }

  private async saveRecord(
    em: EntityManager,
    user: AuthUser,
    def: ResourceDef,
    existing: ResourceRecord | null,
    input: Record<string, unknown>,
    options: { status?: string; note?: string; cleanup?: string[]; logAction?: string } = {},
  ): Promise<ResourceRecord> {
    let status = options.status ?? existing?.status ?? def.defaultStatus;
    if (!def.statuses.some((s) => s.value === status)) throw new BadRequestException('状态不合法');

    // 没有权限的字段，提交的值直接丢弃（保留原值）
    const blocked = readOnlyFieldKeys(def, createChecker(user.permissions));
    if (blocked.size > 0) {
      input = { ...input };
      for (const k of blocked) delete input[k];
    }
    const secrets = existing ? this.readSecrets(existing) : {};
    // 校验时把已有的证件号/卡号也算进“已有值”，这样编辑时没提交必填的证件号不会误报
    const existingForValidation = existing ? { ...existing.data } : undefined;
    if (existingForValidation) {
      for (const f of def.fields) if (f.type === 'sensitive' && secrets[f.key]) existingForValidation[f.key] = true;
    }
    const { values, errors } = validateResourceInput(def, input, { status, existing: existingForValidation });
    if (errors.length > 0) throw new BadRequestException(errors.join('；'));

    const data: Record<string, unknown> = { ...(existing?.data ?? {}) };
    let secretChanged = false;
    for (const f of def.fields) {
      if (!(f.key in values)) continue;
      const v = values[f.key];
      if (f.type === 'secret') {
        // 密码：空值 = 不修改，避免编辑时把已有密码清掉
        if (typeof v === 'string' && v.length > 0) {
          secrets[f.key] = this.crypto.encrypt(v);
          secretChanged = true;
        }
        continue;
      }
      if (f.type === 'sensitive') {
        // 证件号/卡号：明文编辑，清空就是清除
        let old: string | undefined;
        try {
          old = secrets[f.key] ? this.crypto.decrypt(secrets[f.key]) : undefined;
        } catch {
          old = undefined;
        }
        const next = typeof v === 'string' && v.length > 0 ? v : undefined;
        if (next !== old) {
          if (next) secrets[f.key] = this.crypto.encrypt(next);
          else delete secrets[f.key];
          secretChanged = true;
        }
        continue;
      }
      if (v === null) delete data[f.key];
      else data[f.key] = v;
    }
    // 状态变化后不再显示的字段也要清掉（如异常原因）
    for (const f of def.fields) {
      if (f.showWhen && f.showWhen.field === 'status' && !f.showWhen.in.includes(status)) delete data[f.key];
    }

    const ruleCtx = { em, host: this, user, data, existing, status };
    await beforeSaveRule(def.key, ruleCtx);
    status = ruleCtx.status; // 规则可以改状态（如固定资产新建时有使用人就是使用中）
    for (const k of Object.keys(data)) if (data[k] === null || data[k] === undefined) delete data[k];

    for (const f of def.fields) {
      const present = f.type === 'sensitive' ? Boolean(secrets[f.key]) : data[f.key] !== undefined && data[f.key] !== null;
      if (f.required && f.type !== 'secret' && !present && !blocked.has(f.key)) throw new BadRequestException(`${f.label}不能为空`);
    }
    for (const f of def.fields) {
      if (f.type === 'files' && Array.isArray(data[f.key])) {
        await this.files.verify(em, user.companyId, def.key, f.key, data[f.key] as number[], existing?.id ?? null);
      }
    }
    await this.checkRefs(em, user, def, data, existing);
    await this.checkUniqueTogether(em, user, def, data, existing);

    const title = String(data[def.titleField] ?? '').trim();
    if (!title) throw new BadRequestException('缺少标题字段');
    // 加密字段（如银行卡号）作唯一键：明文只在本次提交里，没改就沿用原来的键
    const ufDef = def.uniqueField ? def.fields.find((f) => f.key === def.uniqueField) : undefined;
    const uniqueKey = !def.uniqueField
      ? null
      : ufDef?.type === 'sensitive'
        ? (input[def.uniqueField] === undefined ? existing?.uniqueKey ?? null : this.uniqueKeyOf(def, input[def.uniqueField]))
        : this.uniqueKeyOf(def, data[def.uniqueField]);
    if (uniqueKey) {
      const clash = ufDef?.type === 'sensitive' && input[def.uniqueField!] !== undefined
        ? await this.findByUnique(em, user.companyId, def.key, String(input[def.uniqueField!]))
        : await em.findOne(ResourceRecord, { where: { companyId: user.companyId, type: def.key, uniqueKey } });
      if (clash && clash.id !== existing?.id) {
        const label = def.fields.find((f) => f.key === def.uniqueField)?.label ?? '编号';
        throw new ConflictException(`${label}「${String(data[def.uniqueField!] ?? input[def.uniqueField!])}」已存在`);
      }
    }

    const keepReason = existing && existing.status === status ? existing.statusReason : null;
    const before = existing ? ({ ...existing, data: { ...existing.data } } as ResourceRecord) : null;
    const record = existing ?? em.create(ResourceRecord, { companyId: user.companyId, type: def.key, createdBy: user.id });
    Object.assign(record, {
      title: title.slice(0, 200),
      uniqueKey,
      status,
      statusReason: keepReason,
      searchText: this.buildSearchText(def, data, title),
      data,
      secrets: Object.keys(secrets).length > 0 ? JSON.stringify(secrets) : null,
      updatedBy: user.id,
    });
    try {
      await em.save(ResourceRecord, record);
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw new ConflictException('编号重复');
      throw e;
    }

    await this.syncLinks(em, user, def, record);
    for (const f of def.fields) {
      if (f.type !== 'files') continue;
      const keep = Array.isArray(record.data[f.key]) ? (record.data[f.key] as number[]) : [];
      await this.files.bind(em, user.companyId, record.id, keep);
      const removed = await this.files.dropRemoved(em, user.companyId, def.key, record.id, f.key, keep);
      options.cleanup?.push(...removed);
    }
    const note = [options.note, secretChanged ? '修改了密码/证件号/卡号类字段' : null].filter(Boolean).join('；') || undefined;
    await this.writeLog(em, user, def, record.id, options.logAction ?? (existing ? 'update' : 'create'), before, record, note);
    if (!existing) await afterCreateRule(def.key, { em, host: this, user, record, plain: values });
    await afterSaveRule(def.key, { em, host: this, user, record, existing: before });
    return record;
  }

  private async syncLinks(em: EntityManager, user: AuthUser, def: ResourceDef, record: ResourceRecord) {
    await em.delete(ResourceLink, { companyId: user.companyId, sourceId: record.id, relation: Not('manual') });
    for (const f of def.fields) {
      const v = record.data[f.key];
      if (f.type === 'ref' && f.ref !== 'department' && typeof v === 'number') {
        await em.insert(ResourceLink, {
          companyId: user.companyId,
          sourceType: def.key,
          sourceId: record.id,
          relation: f.key,
          targetType: f.ref!,
          targetId: v,
        });
      }
    }
  }

  // ---------- RuleHost ----------

  async findByUnique(em: EntityManager, companyId: number, type: string, uniqueKey: string) {
    const def = this.def(type);
    const raw = toUniqueKey(def, uniqueKey)!;
    const keys = def.fields.find(f => f.key === def.uniqueField)?.type === 'sensitive' ? this.crypto.indexTokens(raw) : [raw];
    return em.findOne(ResourceRecord, { where: { companyId, type, uniqueKey: In(keys) } });
  }

  async createRecord(em: EntityManager, user: AuthUser, type: string, values: Record<string, unknown>, note?: string) {
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    return this.saveRecord(em, user, this.def(type), null, clean, { note });
  }

  /** 仅服务器迁移CLI调用，无HTTP入口；保留与手工录入相同的字段/引用/加密校验。 */
  async importRecord(em: EntityManager, user: AuthUser, type: string, values: Record<string, unknown>, status?: string) {
    if (em.queryRunner?.data.legacyImport !== true || !user.permissions.isCompanyAdmin) throw new ForbiddenException('仅允许受控迁移事务');
    return this.saveRecord(em, user, this.def(type), null, values, { status, note: '旧系统资料迁入，来源对照见迁移账本' });
  }

  async importPatch(em: EntityManager, user: AuthUser, type: string, id: number, values: Record<string, unknown>) {
    if (em.queryRunner?.data.legacyImport !== true || !user.permissions.isCompanyAdmin) throw new ForbiddenException('仅允许受控迁移事务');
    const record = await this.load(em, user, type, id);
    return this.saveRecord(em, user, this.def(type), record, values, { note: '旧系统资料迁入字段补齐' });
  }

  async titleOf(em: EntityManager, companyId: number, type: string, id: number) {
    const r = await em.findOne(ResourceRecord, { where: { id, companyId, type }, select: ['id', 'title'] });
    return r?.title ?? null;
  }

  async findWhere(em: EntityManager, companyId: number, type: string, field: string, value: string | number) {
    if (!/^[A-Za-z0-9_]+$/.test(field)) throw new BadRequestException('字段名不合法');
    return em
      .createQueryBuilder(ResourceRecord, 'r')
      .where('r.companyId = :companyId AND r.type = :type', { companyId, type })
      .andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${field}')) = :v`, { v: String(value) })
      .getMany();
  }

  /** 规则里改别的记录（如组合行变化后刷新组合的编码）：直接改数据并记日志，不重新走完整校验。 */
  async patchData(em: EntityManager, user: AuthUser, type: string, id: number, patch: Record<string, unknown>, note?: string) {
    const def = this.def(type);
    const record = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type } });
    if (!record) return;
    const before = { ...record, data: { ...record.data } } as ResourceRecord;
    const data: Record<string, unknown> = { ...record.data, ...patch };
    for (const k of Object.keys(data)) if (data[k] === null || data[k] === undefined) delete data[k];
    const title = String(data[def.titleField] ?? record.title).slice(0, 200);
    if (JSON.stringify(data) === JSON.stringify(record.data) && title === record.title) return;
    let uniqueKey = record.uniqueKey;
    if (def.uniqueField && patch[def.uniqueField] !== undefined) {
      uniqueKey = this.uniqueKeyOf(def, data[def.uniqueField]);
      if (uniqueKey) {
        const clash = await em.findOne(ResourceRecord, { where: { companyId: user.companyId, type, uniqueKey } });
        if (clash && clash.id !== id) throw new ConflictException(`「${String(data[def.uniqueField])}」已存在，请先处理重复的编码`);
      }
    }
    Object.assign(record, { data, title, uniqueKey, searchText: this.buildSearchText(def, data, title), updatedBy: user.id });
    await em.save(ResourceRecord, record);
    await this.writeLog(em, user, def, id, 'update', before, record, note);
  }

  /** 规则里直接改别的记录的状态（如商品变了，已验证的基础编码要“需重新验证”）。 */
  async setStatusDirect(em: EntityManager, user: AuthUser, type: string, id: number, status: string, note?: string) {
    const def = this.def(type);
    const record = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type } });
    if (!record || record.status === status) return;
    const before = { ...record, data: { ...record.data } } as ResourceRecord;
    record.status = status;
    record.statusReason = null;
    record.updatedBy = user.id;
    await em.save(ResourceRecord, record);
    await this.writeLog(em, user, def, id, 'update', before, record, note);
  }

  async countWhere(em: EntityManager, companyId: number, type: string, field: string, value: unknown) {
    const rows = await em.find(ResourceRecord, { where: { companyId, type }, select: ['id', 'data'] });
    return rows.filter((r) => sameJson(r.data[field], value)).length;
  }

  // ---------- 对外接口 ----------

  async list(user: AuthUser, type: string, q: ListQuery) {
    const def = this.def(type);
    const em = this.dataSource.manager;
    const page = Math.max(1, Math.floor(q.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(q.pageSize ?? 20)));
    const hiddenStatuses = def.statuses.filter((s) => s.hidden).map((s) => s.value);

    const filterPairs: Array<[string, string]> = [];
    const viewPairs: Array<[string, string]> = [];
    if (q.fieldKey && q.fieldValue !== undefined) filterPairs.push([q.fieldKey, String(q.fieldValue)]);
    if (q.filters) {
      let obj: unknown;
      try { obj = JSON.parse(q.filters); } catch { throw new BadRequestException('筛选条件不合法'); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new BadRequestException('筛选条件不合法');
      for (const [k, v] of Object.entries(obj as Record<string, unknown>).slice(0, 8)) {
        if (v === '' || v === null || v === undefined) continue;
        if (isViewFilter(type, k)) viewPairs.push([k, String(v)]);
        else filterPairs.push([k, String(v)]);
      }
    }
    // 分类字段：选上级分类时，下级分类的资料一并列出（商品分类、供应商分类等所有树形资料通用）
    const catIds = new Map<string, number[]>();
    for (const [key, val] of filterPairs) {
      const f = def.fields.find((x) => x.key === key);
      if (f?.ref && isTreeResource(f.ref) && /^\d+$/.test(val)) {
        const cats = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: f.ref }, select: ['id', 'data'] });
        const kids = new Map<number, number[]>();
        for (const c of cats) {
          const pid = Number((c.data as Record<string, unknown>)?.parentId);
          if (pid) kids.set(pid, [...(kids.get(pid) ?? []), c.id]);
        }
        const out = [Number(val)];
        for (let n = 0; n < out.length && out.length < 2000; n++) out.push(...(kids.get(out[n]) ?? []));
        catIds.set(key, out);
      }
    }

    let expiringIds: number[] | null = null;
    if (q.expiring) {
      expiringIds = [...new Set((await this.expiring(user, 30, true)).rows.filter((r) => r.type === type).map((r) => r.id))];
      if (!expiringIds.length) expiringIds = [0];
    }

    const base = () => {
      const qb = em
        .createQueryBuilder(ResourceRecord, 'r')
        .where('r.companyId = :companyId AND r.type = :type', { companyId: user.companyId, type });
      qb.andWhere(q.archived ? 'r.archivedAt IS NOT NULL' : 'r.archivedAt IS NULL');
      if (expiringIds) qb.andWhere('r.id IN (:...expiringIds)', { expiringIds });
      if (q.ids?.length) qb.andWhere('r.id IN (:...pickIds)', { pickIds: q.ids.slice(0, 2000) });
      if (q.archived) {
        // 已归档列表：不再按“隐藏状态”过滤（归档后的状态本来就是停用/注销）
      } else if (q.status) {
        if (!def.statuses.some((s) => s.value === q.status)) throw new BadRequestException('状态不合法');
        qb.andWhere('r.status = :status', { status: q.status });
      } else if (!q.showHidden && hiddenStatuses.length > 0) {
        qb.andWhere('r.status NOT IN (:...hiddenStatuses)', { hiddenStatuses });
      }
      if (q.archived && q.status) qb.andWhere('r.status = :status', { status: q.status });
      (q.keyword ?? '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5)
        .forEach((word, i) => qb.andWhere(`r.searchText LIKE :kw${i} ESCAPE '\\\\'`, { [`kw${i}`]: `%${likeEscape(word)}%` }));
      filterPairs.forEach(([key, val], i) => {
        const f = def.fields.find((x) => x.key === key);
        if (!f) throw new BadRequestException('筛选字段不存在');
        const ids = catIds.get(key);
        if (ids && f.type === 'refs') qb.andWhere(`JSON_OVERLAPS(JSON_EXTRACT(r.data, '$.${f.key}'), CAST(:fi${i} AS JSON))`, { [`fi${i}`]: JSON.stringify(ids) });
        else if (ids) qb.andWhere(`CAST(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${f.key}')) AS UNSIGNED) IN (:...fi${i})`, { [`fi${i}`]: ids });
        else qb.andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${f.key}')) = :fv${i}`, { [`fv${i}`]: val });
      });
      return qb;
    };

    const listQb = base();
    for (const [i, [k, v]] of viewPairs.entries()) {
      if (!(await applyViewFilter(listQb, em, user.companyId, type, k, v, todayShanghai(), i))) throw new BadRequestException('筛选条件不合法');
    }
    if (q.tab && def.tabsBy) {
      listQb.andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${def.tabsBy}')) = :tab`, { tab: q.tab });
    }
    const sortF = q.sortBy ? def.fields.find((f) => f.key === q.sortBy) : undefined;
    if (q.sortBy && (!sortF || !['text', 'textarea', 'number', 'money', 'date', 'monthday', 'select'].includes(sortF.type))) throw new BadRequestException('这个字段不能排序');
    if (sortF) {
      const dir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
      const numeric = sortF.type === 'number' || sortF.type === 'money';
      const expr = `JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${sortF.key}'))`;
      listQb.addSelect(numeric ? `CAST(${expr} AS DECIMAL(30,6))` : expr, 'sortv').orderBy('sortv', dir).addOrderBy('r.id', 'DESC');
    } else if (def.sortField) {
      // 经营数据这类按日期倒序；日期是 YYYY-MM-DD，按文本排序即可
      listQb.addSelect(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${def.sortField}'))`, 'sortv').orderBy('sortv', 'DESC').addOrderBy('r.id', 'DESC');
    } else {
      listQb.orderBy('r.id', 'DESC');
    }
    const [records, total] = await Promise.all([
      listQb.offset((page - 1) * pageSize).limit(pageSize).getMany(),
      listQb.getCount(),
    ]);

    let tabCounts: Record<string, number> | undefined;
    if (def.tabsBy) {
      const countQb = base();
      for (const [i, [k, v]] of viewPairs.entries()) await applyViewFilter(countQb, em, user.companyId, type, k, v, todayShanghai(), i);
      const rows = await countQb
        .select(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${def.tabsBy}'))`, 'tab')
        .addSelect('COUNT(*)', 'n')
        .groupBy('tab')
        .getRawMany<{ tab: string | null; n: string }>();
      tabCounts = {};
      for (const row of rows) tabCounts[row.tab ?? ''] = Number(row.n);
    }

    let archivedCount: number | undefined;
    if (archivePolicyOf(type)) {
      archivedCount = await em.count(ResourceRecord, { where: { companyId: user.companyId, type, archivedAt: Not(IsNull()) } });
    }
    return { items: await this.toDtos(em, user, def, records), total, page, pageSize, tabCounts, archivedCount };
  }

  /** 列表左侧的分类目录：该字段所指分类树的全部节点，带各节点（含下级）下的资料数。 */
  async categoryTree(user: AuthUser, type: string, fieldKey: string, q: { tab?: string; status?: string; showHidden?: boolean }) {
    const def = this.def(type);
    const field = treeFilterField(def);
    if (!field || field.key !== fieldKey) throw new BadRequestException('这个字段没有分类目录');
    const em = this.dataSource.manager;
    const target = field.ref!;
    const tdef = this.def(target);
    const cats = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: target }, select: ['id', 'title', 'status', 'data'] });
    const hidden = new Set(tdef.statuses.filter((s) => s.hidden).map((s) => s.value));
    const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
    let nodes = cats.filter((c) => !hidden.has(c.status) || q.showHidden).map((c) => ({
      id: c.id, title: c.title, status: c.status, parentId: num((c.data as Record<string, unknown>).parentId), sort: Number((c.data as Record<string, unknown>).sort) || 0,
      tab: def.tabsBy && tdef.fields.some((f) => f.key === def.tabsBy) ? String((c.data as Record<string, unknown>)[def.tabsBy] ?? '') : '',
    }));
    // 页签切换时，只显示属于这个页签的分类
    if (q.tab && def.tabsBy && tdef.fields.some((f) => f.key === def.tabsBy)) {
      const roots = def.treeTabMap?.[q.tab] ?? [q.tab];
      nodes = nodes.filter((n) => roots.includes(n.tab));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const parentOf = new Map(cats.map((c) => [c.id, num((c.data as Record<string, unknown>).parentId)]));

    const hiddenStatuses = def.statuses.filter((s) => s.hidden).map((s) => s.value);
    const qb = em.createQueryBuilder(ResourceRecord, 'r').select(['r.id', 'r.data']).where('r.companyId = :companyId AND r.type = :type', { companyId: user.companyId, type });
    if (q.status) qb.andWhere('r.status = :status', { status: q.status });
    else if (!q.showHidden && hiddenStatuses.length) qb.andWhere('r.status NOT IN (:...hiddenStatuses)', { hiddenStatuses });
    if (q.tab && def.tabsBy) qb.andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${def.tabsBy}')) = :tab`, { tab: q.tab });
    const records = await qb.getMany();
    const members = new Map<number, Set<number>>(); // 分类 -> 其下（含下级）的资料 id
    let uncategorized = 0;
    for (const r of records) {
      const v = (r.data as Record<string, unknown>)[field.key];
      const direct = (field.type === 'refs' ? (Array.isArray(v) ? v : []) : [v]).filter((x): x is number => typeof x === 'number');
      if (!direct.length) { uncategorized++; continue; }
      for (const d of direct) {
        for (let cur = d, i = 0; cur && i < 8; cur = parentOf.get(cur) ?? 0, i++) {
          if (!members.has(cur)) members.set(cur, new Set());
          members.get(cur)!.add(r.id);
        }
      }
    }
    return {
      field: field.key,
      total: records.length,
      uncategorized,
      nodes: nodes
        .map((n) => ({ id: n.id, title: n.title, status: n.status, parentId: ids.has(n.parentId) ? n.parentId : 0, sort: n.sort, count: members.get(n.id)?.size ?? 0 }))
        .sort((a, b) => a.sort - b.sort || a.id - b.id),
    };
  }

  async get(user: AuthUser, type: string, id: number) {
    const def = this.def(type);
    const record = await this.load(this.dataSource.manager, user, type, id);
    return (await this.toDtos(this.dataSource.manager, user, def, [record]))[0];
  }

  async create(user: AuthUser, type: string, values: Record<string, unknown>, status?: string) {
    const def = this.def(type);
    const cleanup: string[] = [];
    const record = await this.dataSource.transaction((em) => this.saveRecord(em, user, def, null, values, { status, cleanup }));
    await this.files.deleteObjects(user.companyId, cleanup);
    return this.get(user, type, record.id);
  }

  async update(user: AuthUser, type: string, id: number, values: Record<string, unknown>) {
    const def = this.def(type);
    const cleanup: string[] = [];
    await this.dataSource.transaction(async (em) => {
      const existing = await this.load(em, user, type, id);
      if (existing.archivedAt) throw new ConflictException('这条资料已归档，请先恢复再修改');
      await this.saveRecord(em, user, def, existing, values, { cleanup });
    });
    await this.files.deleteObjects(user.companyId, cleanup);
    return this.get(user, type, id);
  }

  /** 往来档案（供应商、客户）保存前的相似/重复检测 */
  async similarCheck(user: AuthUser, type: string, values: Record<string, unknown>, excludeId?: number) {
    if (!SIMILARITY_RESOURCES.includes(type)) throw new BadRequestException('这类资料不做相似检测');
    const rows = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type }, select: ['id', 'data'] });
    const r = inspectArchiveSimilarity(values, rows.map((x) => ({ id: x.id, data: x.data })), excludeId);
    return { blocked: r.blocked.slice(0, 6).map((m) => ({ ...m, text: formatSimilarityMatch(m) })), warnings: r.warnings.slice(0, 6).map((m) => ({ ...m, text: formatSimilarityMatch(m) })) };
  }

  /** 批量改字段（仅限资料定义里声明的 batch 字段）或批量改状态；逐条走统一保存流程，失败的单独返回 */
  async batchUpdate(user: AuthUser, type: string, ids: number[], values: Record<string, unknown>, status?: string, reason?: string) {
    const def = this.def(type);
    const allowed = def.batch ?? [];
    if (!allowed.length) throw new BadRequestException('这类资料不支持批量修改');
    const keys = Object.keys(values);
    if (!keys.length && !status) throw new BadRequestException('请选择要批量修改的内容');
    for (const k of keys) if (!allowed.includes(k)) throw new BadRequestException('不能批量修改这个字段');
    if (status && !allowed.includes('status')) throw new BadRequestException('不能批量修改状态');
    const uniq = [...new Set(ids)];
    if (!uniq.length) throw new BadRequestException('请先勾选要修改的记录');
    let done = 0;
    const failed: Array<{ id: number; message: string }> = [];
    for (const id of uniq) {
      try {
        if (keys.length) await this.update(user, type, id, values);
        if (status) await this.changeStatus(user, type, id, status, reason);
        done++;
      } catch (e) {
        failed.push({ id, message: e instanceof Error ? e.message : '修改失败' });
      }
    }
    return { done, failed };
  }

  /** 在调用方的事务里改状态，并走完整的保存规则（如组合“验证”会生成快照）；状态相同则什么都不做。 */
  async setStatusChecked(em: EntityManager, user: AuthUser, type: string, id: number, status: string, note?: string) {
    const existing = await this.load(em, user, type, id);
    if (existing.status === status) return;
    await this.saveRecord(em, user, this.def(type), existing, {}, { status, note: note ?? `状态：${existing.status} → ${status}` });
  }

  /** 在调用方的事务里按统一保存流程改字段并（可选）改状态，日志动作可自定（如固定资产的“领用”）。 */
  async saveChecked(em: EntityManager, user: AuthUser, type: string, id: number, values: Record<string, unknown>, options: { status?: string; note?: string; logAction?: string; statusReason?: string | null } = {}) {
    const existing = await this.load(em, user, type, id);
    await this.saveRecord(em, user, this.def(type), existing, values, { status: options.status, note: options.note, logAction: options.logAction });
    if (options.statusReason !== undefined) {
      const fresh = await this.load(em, user, type, id);
      fresh.statusReason = options.statusReason ? options.statusReason.trim().slice(0, 500) : null;
      await em.save(ResourceRecord, fresh);
    }
  }

  /** 只记一条操作日志（如盘点“在位”，记录本身没有变化）。 */
  async logAction(em: EntityManager, user: AuthUser, type: string, id: number, action: string, note: string) {
    const record = await this.load(em, user, type, id);
    await this.writeLog(em, user, this.def(type), id, action, record, record, note);
  }

  async changeStatus(user: AuthUser, type: string, id: number, status: string, reason?: string) {
    const def = this.def(type);
    const problem = validateStatusChange(def, status, reason);
    if (problem) throw new BadRequestException(problem);
    await this.dataSource.transaction(async (em) => {
      const existing = await this.load(em, user, type, id);
      if (existing.archivedAt) throw new ConflictException('这条资料已归档，请先恢复再改状态');
      if (existing.status === status) return;
      const needsReason = def.statuses.find((s) => s.value === status)?.requiresReason;
      // 走统一保存流程，这样状态相关字段的清理、规则校验、日志都一致
      // 改为异常：原因同时写进异常原因字段（有“新的异常原因”输入的资料会自动记入原因库）
      const abnormalInput: Record<string, unknown> = {};
      if (status === 'abnormal' && reason?.trim()) {
        if (def.fields.some((f) => f.key === 'abnormalReasonText')) abnormalInput.abnormalReasonText = reason.trim().slice(0, 100);
        else if (def.fields.some((f) => f.key === 'abnormalReason' && f.type !== 'ref')) abnormalInput.abnormalReason = reason.trim().slice(0, 2000);
      }
      await this.saveRecord(em, user, def, existing, abnormalInput, { status, note: `状态：${existing.status} → ${status}${reason ? `（${reason.trim()}）` : ''}` });
      const fresh = await this.load(em, user, type, id);
      fresh.statusReason = needsReason ? reason!.trim().slice(0, 500) : null;
      await em.save(ResourceRecord, fresh);
    });
    return this.get(user, type, id);
  }

  /** 旧系统同款软归档：只标记这条资料本身（状态变为停用/注销等）并写变更记录，关联和业务历史原样保留，可恢复。 */
  async archive(user: AuthUser, type: string, id: number, reason: string | undefined) {
    const def = this.def(type);
    const policy = archivePolicyOf(type);
    if (!policy) throw new BadRequestException('该资料类型不支持归档');
    const text = (reason ?? '').trim();
    if (!text) throw new BadRequestException('归档必须填写归档原因');
    if (text.length > 500) throw new BadRequestException('原因不能超过 500 个字');
    await this.dataSource.transaction(async (em) => {
      const before = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type }, lock: { mode: 'pessimistic_write' } });
      if (!before) throw new NotFoundException('记录不存在');
      if (before.archivedAt) throw new ConflictException('该资料已归档');
      if (type === 'tax-profiles') {
        const licenseId = before.data.licenseId;
        if (typeof licenseId === 'number' && (await em.count(ResourceRecord, { where: { id: licenseId, companyId: user.companyId, type: 'licenses', archivedAt: IsNull() } })))
          throw new BadRequestException('营业执照仍然存在，不能归档对应税务资料');
      }
      await em.update(
        ResourceRecord,
        { id, companyId: user.companyId },
        { archivedAt: () => 'CURRENT_TIMESTAMP', archivedBy: user.id, archiveReason: text, archivedFromStatus: before.status, status: policy.archivedStatus, updatedBy: user.id },
      );
      const after = await this.load(em, user, type, id);
      await this.writeLog(em, user, def, id, 'archived', before, after, `归档原因：${text}`);
    });
    return this.get(user, type, id);
  }

  async restore(user: AuthUser, type: string, id: number, reason: string | undefined) {
    const def = this.def(type);
    const policy = archivePolicyOf(type);
    if (!policy) throw new BadRequestException('该资料类型不支持归档');
    const text = (reason ?? '').trim();
    if (!text) throw new BadRequestException('恢复必须填写恢复原因');
    if (text.length > 500) throw new BadRequestException('原因不能超过 500 个字');
    await this.dataSource.transaction(async (em) => {
      const before = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type }, lock: { mode: 'pessimistic_write' } });
      if (!before) throw new NotFoundException('记录不存在');
      if (!before.archivedAt) throw new ConflictException('该资料未归档，无需恢复');
      const restored = before.archivedFromStatus && def.statuses.some((x) => x.value === before.archivedFromStatus) ? before.archivedFromStatus : policy.defaultStatus;
      await em.update(
        ResourceRecord,
        { id, companyId: user.companyId },
        { status: restored, statusReason: null, archivedAt: null, archivedBy: null, archiveReason: null, archivedFromStatus: null, updatedBy: user.id },
      );
      const after = await this.load(em, user, type, id);
      await this.writeLog(em, user, def, id, 'restored', before, after, `恢复原因：${text}`);
    });
    return this.get(user, type, id);
  }

  async remove(user: AuthUser, type: string, id: number, reason: string | undefined) {
    const def = this.def(type);
    // 旧系统里这些资料不物理删除：删除 = 归档
    if (archivePolicyOf(type)) return this.archive(user, type, id, reason);
    if (!reason || reason.trim().length < 2) throw new BadRequestException('删除必须填写原因');
    const cleanup: string[] = [];
    await this.dataSource.transaction(async (em) => {
      const existing = await this.load(em, user, type, id);
      await beforeDeleteRule(def.key, { em, host: this, user, record: existing });
      const incoming = await em.find(ResourceLink, { where: { companyId: user.companyId, targetType: type, targetId: id, relation: Not('manual') } });
      if (incoming.length > 0) {
        const sources = await em
          .createQueryBuilder(ResourceRecord, 'r')
          .select(['r.id', 'r.type', 'r.title'])
          .where('r.companyId = :c AND r.id IN (:...ids)', { c: user.companyId, ids: incoming.map((l) => l.sourceId) })
          .limit(3)
          .getMany();
        const names = sources.map((s) => `${getResourceDef(s.type)?.label ?? s.type}「${s.title}」`).join('、');
        throw new ConflictException(`还被 ${incoming.length} 条记录引用（${names}${incoming.length > 3 ? ' 等' : ''}），请先解除引用，或改为停用`);
      }
      await em.delete(ResourceLink, { companyId: user.companyId, sourceId: id });
      await em.delete(ResourceLink, { companyId: user.companyId, targetType: type, targetId: id, relation: 'manual' });
      await em.delete(ResourceRecord, { id, companyId: user.companyId });
      cleanup.push(...(await this.files.deleteAllFor(em, user.companyId, type, id)));
      await afterDeleteRule(def.key, { em, host: this, user, record: existing });
      await this.writeLog(em, user, def, id, 'delete', existing, null, reason.trim());
    });
    await this.files.deleteObjects(user.companyId, cleanup);
    return { ok: true };
  }

  /** 查看密码/证件号明文：要 secret 权限，并留下查看记录。 */
  async reveal(user: AuthUser, type: string, id: number, field: string) {
    const def = this.def(type);
    const f = def.fields.find((x) => x.key === field && (x.type === 'secret' || x.type === 'sensitive'));
    if (!f) throw new NotFoundException('没有这个字段');
    return this.dataSource.transaction(async (em) => {
      const record = await this.load(em, user, type, id);
      const token = this.readSecrets(record)[field];
      if (!token) throw new NotFoundException('这个字段还没有设置');
      await this.writeLog(em, user, def, id, 'reveal', null, null, `查看了「${f.label}」`);
      return { field, value: this.crypto.decrypt(token) };
    });
  }

  async logs(user: AuthUser, type: string, id: number) {
    this.def(type);
    const em = this.dataSource.manager;
    await this.load(em, user, type, id);
    const rows = await em.find(ResourceChangeLog, {
      where: { companyId: user.companyId, resourceType: type, resourceId: id },
      order: { id: 'DESC' },
      take: 100,
    });
    const actors = rows.length
      ? await em
          .createQueryBuilder(User, 'u')
          .select(['u.id', 'u.name'])
          .where('u.companyId = :c AND u.id IN (:...ids)', { c: user.companyId, ids: [...new Set(rows.map((r) => r.actorId).filter((x): x is number => x != null))].concat([0]) })
          .getMany()
      : [];
    const nameOf = new Map(actors.map((a) => [a.id, a.name]));
    const def = this.def(type);
    const hide = restrictedFieldKeys(def, createChecker(user.permissions));
    const strip = (v: Record<string, unknown> | null) => {
      if (!v || hide.size === 0) return v;
      const copy = { ...v };
      for (const k of hide) delete copy[k];
      return copy;
    };
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actorId ? (nameOf.get(r.actorId) ?? `#${r.actorId}`) : '系统',
      note: r.note,
      before: strip(r.beforeJson as Record<string, unknown> | null),
      after: strip(r.afterJson as Record<string, unknown> | null),
      createdAt: r.createdAt,
    }));
  }

  private linkProps(l: ResourceLink) {
    return l.relation === 'manual' ? { validFrom: l.validFrom, validTo: l.validTo, purpose: l.purpose } : {};
  }

  private cleanLinkProps(p: { validFrom?: string | null; validTo?: string | null; purpose?: string | null }) {
    const date = (v: unknown, label: string) => {
      if (v === undefined || v === null || v === '') return null;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new BadRequestException(`${label}格式应为 YYYY-MM-DD`);
      return v;
    };
    const validFrom = date(p.validFrom, '开始日期');
    const validTo = date(p.validTo, '结束日期');
    if (validFrom && validTo && validTo < validFrom) throw new BadRequestException('结束日期不能早于开始日期');
    const purpose = typeof p.purpose === 'string' && p.purpose.trim() ? p.purpose.trim().slice(0, 200) : null;
    return { validFrom, validTo, purpose };
  }

  /** 这条记录指向了谁、又被谁引用。 */
  async relations(user: AuthUser, type: string, id: number, can: (permission: string) => boolean) {
    this.def(type);
    const em = this.dataSource.manager;
    await this.load(em, user, type, id);
    const links = await em
      .createQueryBuilder(ResourceLink, 'l')
      .where('l.companyId = :c AND ((l.sourceType = :t AND l.sourceId = :id) OR (l.targetType = :t AND l.targetId = :id))', {
        c: user.companyId,
        t: type,
        id,
      })
      .getMany();
    const out: Array<{ direction: 'out' | 'in'; relation: string; type: string; id: number; title: string; linkId?: number; validFrom?: string | null; validTo?: string | null; purpose?: string | null }> = [];
    const wantUsers = new Set<number>();
    const wantRecords = new Set<number>();
    for (const l of links) {
      const outgoing = l.sourceType === type && l.sourceId === id;
      if (outgoing) (l.targetType === 'user' ? wantUsers : wantRecords).add(l.targetId);
      else wantRecords.add(l.sourceId);
    }
    const users = wantUsers.size ? await em.find(User, { where: [...wantUsers].map((uid) => ({ id: uid, companyId: user.companyId })) }) : [];
    const records = wantRecords.size
      ? await em
          .createQueryBuilder(ResourceRecord, 'r')
          .select(['r.id', 'r.type', 'r.title'])
          .where('r.companyId = :c AND r.id IN (:...ids)', { c: user.companyId, ids: [...wantRecords] })
          .getMany()
      : [];
    for (const l of links) {
      if (l.sourceType === type && l.sourceId === id) {
        if (l.targetType === 'user') out.push({ direction: 'out', relation: l.relation, type: 'user', id: l.targetId, title: users.find((u) => u.id === l.targetId)?.name ?? `#${l.targetId}`, linkId: l.id, ...this.linkProps(l) });
        else {
          const r = records.find((x) => x.id === l.targetId && x.type === l.targetType);
          if (r) out.push({ direction: 'out', relation: l.relation, type: r.type, id: r.id, title: r.title, linkId: l.id, ...this.linkProps(l) });
        }
      } else {
        const r = records.find((x) => x.id === l.sourceId && x.type === l.sourceType);
        if (r) out.push({ direction: 'in', relation: l.relation, type: r.type, id: r.id, title: r.title, linkId: l.id, ...this.linkProps(l) });
      }
    }
    // 只给出调用者有权查看的资料类型，避免通过关联“窥探”无权限的资料
    return out.filter((x) => x.type === 'user' || can(resourcePermission(permissionOwner(x.type), 'view')));
  }

  /** 手动关联：把另一条资料关联到这条上（一条可以关联多条，如合作人对应多个执照/店铺）。 */
  async addManualLink(user: AuthUser, type: string, id: number, targetType: string, targetId: number, can: (permission: string) => boolean, props: { validFrom?: string | null; validTo?: string | null; purpose?: string | null } = {}) {
    this.def(type);
    const clean = this.cleanLinkProps(props);
    const tdef = getResourceDef(targetType);
    if (!tdef) throw new BadRequestException('要关联的资料类型不存在');
    if (!can(resourcePermission(permissionOwner(targetType), 'view'))) throw new ForbiddenException('没有权限查看要关联的资料');
    if (targetType === type && targetId === id) throw new BadRequestException('不能关联自己');
    await this.dataSource.transaction(async (em) => {
      const src = await this.load(em, user, type, id);
      const target = await em.findOne(ResourceRecord, { where: { id: targetId, companyId: user.companyId, type: targetType } });
      if (!target) throw new BadRequestException('要关联的资料不存在');
      const dup = await em.findOne(ResourceLink, { where: [
        { companyId: user.companyId, sourceType: type, sourceId: id, targetType, targetId },
        { companyId: user.companyId, sourceType: targetType, sourceId: targetId, targetType: type, targetId: id },
      ] });
      if (dup) throw new ConflictException('已经关联过了');
      await em.insert(ResourceLink, { companyId: user.companyId, sourceType: type, sourceId: id, relation: 'manual', targetType, targetId, ...clean });
      await this.writeLog(em, user, this.def(type), src.id, 'update', src, src, `手动关联${tdef.label}「${target.title}」${clean.purpose ? `（${clean.purpose}）` : ''}${clean.validTo ? `，有效期至 ${clean.validTo}` : ''}`);
    });
    return { ok: true };
  }

  /** 修改手动关联的属性（用途、有效期） */
  async updateManualLink(user: AuthUser, type: string, id: number, linkId: number, props: { validFrom?: string | null; validTo?: string | null; purpose?: string | null }) {
    const def = this.def(type);
    const clean = this.cleanLinkProps(props);
    await this.dataSource.transaction(async (em) => {
      const src = await this.load(em, user, type, id);
      const link = await em.findOne(ResourceLink, { where: { id: linkId, companyId: user.companyId, relation: 'manual' } });
      const ok = link && ((link.sourceType === type && link.sourceId === id) || (link.targetType === type && link.targetId === id));
      if (!link || !ok) throw new NotFoundException('关联不存在');
      await em.update(ResourceLink, { id: linkId }, clean);
      await this.writeLog(em, user, def, src.id, 'update', src, src, `修改关联属性${clean.purpose ? `：${clean.purpose}` : ''}${clean.validTo ? `，有效期至 ${clean.validTo}` : ''}`);
    });
    return { ok: true };
  }

  async removeManualLink(user: AuthUser, type: string, id: number, linkId: number) {
    const def = this.def(type);
    await this.dataSource.transaction(async (em) => {
      const src = await this.load(em, user, type, id);
      const link = await em.findOne(ResourceLink, { where: { id: linkId, companyId: user.companyId, relation: 'manual' } });
      const ok = link && ((link.sourceType === type && link.sourceId === id) || (link.targetType === type && link.targetId === id));
      if (!link || !ok) throw new NotFoundException('关联不存在');
      await em.delete(ResourceLink, { id: linkId });
      await this.writeLog(em, user, def, src.id, 'update', src, src, '取消一条手动关联');
    });
    return { ok: true };
  }

  /** 资料总览：各类数量、异常数、即将到期的预警。只统计当前用户有权查看的类型。 */
  async overview(user: AuthUser) {
    const can = createChecker(user.permissions);
    const em = this.dataSource.manager;
    const items: Array<{ type: string; label: string; total: number; abnormal: number }> = [];
    for (const def of RESOURCE_DEFS) {
      if (!def.nav || def.nav.section || !can(resourcePermission(def.key, 'view'))) continue;
      const hidden = def.statuses.filter((s) => s.hidden).map((s) => s.value);
      const rows = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: def.key, archivedAt: IsNull() }, select: ['id', 'status'] });
      const active = rows.filter((r) => !hidden.includes(r.status));
      items.push({ type: def.key, label: def.label, total: active.length, abnormal: active.filter((r) => r.status === 'abnormal').length });
    }
    return { items };
  }

  /** 即将到期 / 已过期统一列表（旧系统 expiring.js）：按每种资料的查看权限过滤；停用/注销/已归档的不提醒。 */
  async expiring(user: AuthUser, days = 30, includeExpired = true, today: string = todayShanghai()) {
    const can = createChecker(user.permissions);
    const window = Math.min(366, Math.max(0, Math.floor(Number.isFinite(days) ? days : 30)));
    const limit = addDaysText(today, window);
    const em = this.dataSource.manager;
    const sources = expirySources().filter((src) => can(resourcePermission(src.resource, 'view')));
    const types = [...new Set(sources.map((x) => x.resource))];
    const rows: Array<{ type: string; typeLabel: string; id: number; name: string; field: string; fieldLabel: string; dueDate: string; daysLeft: number; status: 'expired' | 'due_soon'; resourceStatus: string }> = [];
    for (const type of types) {
      const def = getResourceDef(type);
      if (!def) continue;
      const records = await em.find(ResourceRecord, {
        where: { companyId: user.companyId, type, archivedAt: IsNull(), status: Not(In([...EXPIRY_SKIP_STATUSES])) },
        select: ['id', 'title', 'status', 'data'],
      });
      for (const src of sources.filter((x) => x.resource === type)) {
        for (const r of records) {
          const due = dueDateFor(src, r.data, today);
          if (!due || due > limit) continue;
          const daysLeft = daysBetweenDates(today, due);
          if (daysLeft < 0 && !includeExpired) continue;
          rows.push({ type, typeLabel: def.label, id: r.id, name: r.title, field: src.field, fieldLabel: src.label, dueDate: due, daysLeft, status: daysLeft < 0 ? 'expired' : 'due_soon', resourceStatus: r.status });
        }
      }
    }
    // 带有效期的手动关联（如商标授权给某店铺的结束日期）：算在关联的两端中“被授权”的一方——这里统一算在来源这条资料上
    const links = await em.find(ResourceLink, { where: { companyId: user.companyId, relation: 'manual', validTo: Not(IsNull()) } });
    if (links.length) {
      const ids = [...new Set(links.flatMap((l) => [l.sourceId, l.targetId]))];
      const recs = await em.find(ResourceRecord, { where: { companyId: user.companyId, id: In(ids), archivedAt: IsNull(), status: Not(In([...EXPIRY_SKIP_STATUSES])) }, select: ['id', 'type', 'title', 'status'] });
      const byId = new Map(recs.map((r) => [r.id, r]));
      for (const l of links) {
        const owner = byId.get(l.sourceId);
        const other = byId.get(l.targetId);
        if (!owner || !other || !l.validTo || l.validTo > limit) continue;
        if (!can(resourcePermission(owner.type, 'view'))) continue;
        const daysLeft = daysBetweenDates(today, l.validTo);
        if (daysLeft < 0 && !includeExpired) continue;
        rows.push({ type: owner.type, typeLabel: getResourceDef(owner.type)?.label ?? owner.type, id: owner.id, name: owner.title, field: `link:${l.id}`, fieldLabel: `关联到期（${other.title}${l.purpose ? `·${l.purpose}` : ''}）`, dueDate: l.validTo, daysLeft, status: daysLeft < 0 ? 'expired' : 'due_soon', resourceStatus: owner.status });
      }
    }
    rows.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.type.localeCompare(b.type) || a.id - b.id));
    return {
      today,
      days: window,
      total: rows.length,
      counts: { expired: rows.filter((x) => x.status === 'expired').length, dueSoon: rows.filter((x) => x.status === 'due_soon').length },
      rows: rows.slice(0, 500),
    };
  }

  // ---------- 导出 / 导入 ----------

  private csvCell(v: unknown): string {
    const s = v === undefined || v === null ? '' : String(v);
    // 防 CSV 公式注入：以 = + - @ 开头的文本前加单引号
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  }

  private displayValue(f: FieldDef, dto: ResourceDto): string {
    const v = dto.data[f.key];
    if (v === undefined || v === null) return '';
    if (f.type === 'select') return f.options?.find((o) => o.value === v)?.label ?? String(v);
    if (f.type === 'money') return f.scale ? unitYuanText(Number(v)) : (Number(v) / 100).toFixed(2);
    if (f.type === 'bool') return v ? '是' : '否';
    if (f.type === 'ref' || f.type === 'refs') return dto.refLabels[f.key] ?? '';
    if (f.type === 'files') return (Array.isArray(v) ? v : []).map((id) => dto.files[id as number]?.name ?? '').filter(Boolean).join('；');
    if (f.type === 'attrs') return Object.entries(v as Record<string, string>).map(([k, x]) => `${k}=${x}`).join('；');
    return String(v);
  }

  async exportCsv(user: AuthUser, type: string, includeHidden: boolean, scope: Partial<ListQuery> = {}) {
    const def = this.def(type);
    const hidden = restrictedFieldKeys(def, createChecker(user.permissions));
    const fields = def.fields.filter((f) => f.type !== 'secret' && !hidden.has(f.key));
    const items: ResourceDto[] = [];
    for (let page = 1; page < 100; page++) {
      const res = await this.list(user, type, { ...scope, page, pageSize: 200, showHidden: includeHidden });
      items.push(...res.items);
      if (items.length >= res.total) break;
    }
    const header = ['状态', ...fields.map((f) => f.label)];
    const lines = [header.map((h) => this.csvCell(h)).join(',')];
    for (const dto of items) {
      const status = def.statuses.find((s) => s.value === dto.status)?.label ?? dto.status;
      lines.push([status, ...fields.map((f) => this.displayValue(f, dto))].map((c) => this.csvCell(c)).join(','));
    }
    return { filename: `${def.label}.csv`, csv: `﻿${lines.join('\r\n')}`, count: items.length };
  }

  /** 把一行（表头为字段中文名）转换成字段值；转换失败返回错误。 */
  private async rowToInput(
    em: EntityManager,
    user: AuthUser,
    def: ResourceDef,
    row: Record<string, string>,
  ): Promise<{ input: Record<string, unknown>; status?: string; errors: string[] }> {
    const input: Record<string, unknown> = {};
    const errors: string[] = [];
    let status: string | undefined;
    const statusText = (row['状态'] ?? '').trim();
    if (statusText) {
      status = def.statuses.find((s) => s.label === statusText || s.value === statusText)?.value;
      if (!status) errors.push(`状态“${statusText}”不认识`);
    }
    for (const f of def.fields) {
      if (f.type === 'secret' || f.type === 'files' || f.type === 'attrs' || f.readonly) continue; // 密码、文件、系统计算的字段不走导入
      let raw = (row[f.label] ?? '').trim();
      // Excel 弄坏的手机号（="138…"、138….0、科学计数法）先还原
      if (raw && (f.type === 'phone' || (def.key === 'stores' && f.key === 'phoneNumber'))) raw = normalizePhoneImportText(raw);
      // 店铺的“所属执照”可填统一社会信用代码
      if (raw && def.key === 'stores' && f.key === 'licenseId') raw = await mapLicenseByCreditCode(em, user.companyId, raw);
      if (!raw) continue;
      if (f.type === 'select') {
        const opt = f.options?.find((o) => o.label === raw || o.value === raw);
        if (!opt) errors.push(`${f.label}“${raw}”不在可选项里`);
        else input[f.key] = opt.value;
      } else if (f.type === 'money') {
        try { input[f.key] = yuanToPreciseCents(raw.replace(/[,，]/g, ''), f.scale ?? 0); }
        catch { errors.push(`${f.label}金额格式或精度不合法`); }
      } else if (f.type === 'decimal') {
        const n = Number(raw.replace(/[,，]/g, ''));
        if (Number.isNaN(n)) errors.push(`${f.label}不是数字`);
        else input[f.key] = n;
      } else if (f.type === 'bool') {
        input[f.key] = ['是', 'true', '1', 'yes'].includes(raw.toLowerCase());
      } else if (f.type === 'ref') {
        if (f.ref === 'user') {
          const matches = await em.find(User, { where: { companyId: user.companyId, name: raw } });
          if (matches.length !== 1) errors.push(`${f.label}“${raw}”${matches.length === 0 ? '找不到该员工' : '有重名员工，无法确定'}`);
          else input[f.key] = matches[0].id;
        } else if (f.ref === 'department') {
          const matches = await em.find(Department, { where: { companyId: user.companyId, name: raw } });
          if (matches.length !== 1) errors.push(`${f.label}“${raw}”${matches.length === 0 ? '找不到该部门' : '有重名部门，无法确定'}`);
          else input[f.key] = matches[0].id;
        } else {
          const matches = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: f.ref!, title: raw }, select: ['id'], take: 2 });
          if (matches.length !== 1) errors.push(`${f.label}“${raw}”${matches.length === 0 ? '找不到' : '有重名，无法确定'}`);
          else input[f.key] = matches[0].id;
        }
      } else {
        input[f.key] = raw;
      }
    }
    if (def.fields.some((f) => f.key === 'source')) input.source = input.source ?? 'import';
    return { input, status, errors };
  }

  /**
   * 批量导入：先在事务里真正执行一遍，出任何错都整体回滚；预览（dryRun）也一律回滚。
   * 有唯一字段的资料按它“有则更新、无则新建”，没有唯一字段的都是新建。
   */
  async importRows(user: AuthUser, type: string, rows: Array<Record<string, string>>, dryRun: boolean, partial = false) {
    const def = this.def(type);
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestException('没有可导入的行');
    if (rows.length > MAX_IMPORT_ROWS) throw new BadRequestException(`一次最多导入 ${MAX_IMPORT_ROWS} 行`);

    const results: Array<{ line: number; action: 'create' | 'update' | 'error'; title?: string; errors: string[]; warnings?: string[] }> = [];
    const cleanup: string[] = [];
    // 真正导入前先留一份整类快照，导错了可以一键恢复；预览不留
    const backupId = dryRun ? null : await this.createImportBackup(user, type);
    try {
      await this.dataSource.transaction(async (em) => {
        for (let i = 0; i < rows.length; i++) {
          const line = i + 2; // 第 1 行是表头
          const converted = await this.rowToInput(em, user, def, rows[i]);
          if (converted.errors.length > 0) {
            results.push({ line, action: 'error', errors: converted.errors });
            continue;
          }
          try {
            const uniqueKey = def.uniqueField ? this.uniqueKeyOf(def, converted.input[def.uniqueField]) : null;
            let existing = uniqueKey
              ? await this.findByUnique(em, user.companyId, type, String(converted.input[def.uniqueField!]))
              : null;
            // 没有唯一字段的资料，按 importMatch 指定的字段组合匹配已有记录
            if (!existing && !def.uniqueField && def.importMatch?.length && def.importMatch.every((k) => converted.input[k] !== undefined && converted.input[k] !== '')) {
              const qb = em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t', { c: user.companyId, t: type });
              def.importMatch.forEach((k, idx) => qb.andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${k}')) = :im${idx}`, { [`im${idx}`]: String(converted.input[k]) }));
              existing = (await qb.getOne()) ?? null;
            }
            const saved = await em.transaction((inner) =>
              this.saveRecord(inner, user, def, existing, converted.input, { status: converted.status, note: '批量导入', cleanup }),
            );
            let warnings: string[] | undefined;
            if (type === 'phones') {
              const storeDef = this.def('stores');
              const bound = await em.transaction((inner) =>
                bindPhoneStores(inner, user, saved, rows[i], (store, input) => this.saveRecord(inner, user, storeDef, store, input, { note: `手机号导入绑定：${saved.title}`, cleanup })),
              );
              if (bound.warnings.length) warnings = bound.warnings;
            }
            results.push({ line, action: existing ? 'update' : 'create', title: saved.title, errors: [], warnings });
          } catch (e) {
            const message = (e as { response?: { message?: string | string[] } }).response?.message ?? (e as Error).message;
            results.push({ line, action: 'error', errors: [Array.isArray(message) ? message.join('；') : String(message)] });
          }
        }
        // 默认有一行有问题就整批不导入；partial=只导入没问题的行（局部成功），有问题的行原样返回
        if (dryRun || (!partial && results.some((r) => r.action === 'error'))) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    const failed = results.filter((r) => r.action === 'error').length;
    const committed = !dryRun && (failed === 0 || (partial && results.length > failed));
    if (committed) await this.files.deleteObjects(user.companyId, cleanup);
    // 没导进去就不留这份备份
    if (backupId && !committed) await this.dataSource.getRepository(ResourceImportBackup).delete({ id: backupId });
    return {
      dryRun,
      committed,
      backupId: committed ? backupId : null,
      created: results.filter((r) => r.action === 'create').length,
      updated: results.filter((r) => r.action === 'update').length,
      failed,
      results,
    };
  }

  // ---------- 导入备份 ----------
  private async createImportBackup(user: AuthUser, type: string): Promise<number | null> {
    const rows = await this.dataSource.getRepository(ResourceRecord).find({ where: { companyId: user.companyId, type } });
    if (rows.length === 0) return null;
    const repo = this.dataSource.getRepository(ResourceImportBackup);
    const saved = await repo.save(
      repo.create({ companyId: user.companyId, resourceType: type, recordCount: rows.length, snapshotJson: JSON.stringify(rows), createdBy: user.id }),
    );
    // 每类只留最近 5 份
    const all = await repo.find({ where: { companyId: user.companyId, resourceType: type }, select: ['id'], order: { id: 'DESC' } });
    if (all.length > 5) await repo.delete(all.slice(5).map((b) => b.id));
    return saved.id;
  }

  async listImportBackups(user: AuthUser, type: string) {
    this.def(type);
    const rows = await this.dataSource.getRepository(ResourceImportBackup).find({
      where: { companyId: user.companyId, resourceType: type },
      select: ['id', 'recordCount', 'createdAt', 'restoredAt', 'createdBy'],
      order: { id: 'DESC' },
      take: 5,
    });
    return rows.map((b) => ({ id: b.id, recordCount: b.recordCount, createdAt: b.createdAt, restoredAt: b.restoredAt }));
  }

  /** 恢复到备份时的样子：快照里的记录覆盖回来，之后新增的记录删掉（被别处引用删不掉的保留并计数）。 */
  async restoreImportBackup(user: AuthUser, type: string, backupId: number) {
    const def = this.def(type);
    const backup = await this.dataSource.getRepository(ResourceImportBackup).findOne({ where: { id: backupId, companyId: user.companyId, resourceType: type } });
    if (!backup) throw new NotFoundException('备份不存在');
    const snapshot = JSON.parse(backup.snapshotJson) as Array<Record<string, unknown>>;
    let restored = 0;
    let removed = 0;
    let skippedDelete = 0;
    await this.dataSource.transaction(async (em) => {
      const keep = new Set(snapshot.map((r) => Number(r.id)));
      for (const row of snapshot) {
        const id = Number(row.id);
        const fields = {
          title: String(row.title),
          uniqueKey: (row.uniqueKey as string | null) ?? null,
          status: String(row.status),
          statusReason: (row.statusReason as string | null) ?? null,
          searchText: String(row.searchText ?? ''),
          data: row.data as Record<string, unknown>,
          secrets: (row.secrets as string | null) ?? null,
          updatedBy: user.id,
        };
        const existing = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type } });
        if (existing) await em.update(ResourceRecord, { id }, fields as never);
        else await em.insert(ResourceRecord, { id, companyId: user.companyId, type, createdBy: (row.createdBy as number | null) ?? null, ...fields } as never);
        restored += 1;
        const rec = await em.findOneOrFail(ResourceRecord, { where: { id } });
        await this.syncLinks(em, user, def, rec);
      }
      const current = await em.find(ResourceRecord, { where: { companyId: user.companyId, type }, select: ['id'] });
      for (const c of current) {
        if (keep.has(c.id)) continue;
        const incoming = await em.count(ResourceLink, { where: { companyId: user.companyId, targetType: type, targetId: c.id, relation: Not('manual') } });
        if (incoming > 0) { skippedDelete += 1; continue; }
        await em.delete(ResourceLink, { companyId: user.companyId, sourceId: c.id });
        await em.delete(ResourceRecord, { id: c.id, companyId: user.companyId });
        removed += 1;
      }
      await em.update(ResourceImportBackup, { id: backupId }, { restoredAt: () => 'NOW()' });
      await em.insert(AuditLog, { companyId: user.companyId, actorId: user.id, action: 'resource.import.restore', resourceType: type, resourceId: String(backupId), detail: { restored, removed, skippedDelete } });
    });
    return { restored, removed, skippedDelete };
  }
}
