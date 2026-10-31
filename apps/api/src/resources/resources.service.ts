import { createHash } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Not, SelectQueryBuilder } from 'typeorm';
import {
  unitYuanText, yuanToPreciseCents, createChecker,
  addDaysText, daysBetweenDates, dueDateFor, expirySources, EXPIRY_SKIP_STATUSES, todayShanghai,
  FieldDef,
  getResourceDef, isKnownRelationKind,
  isTreeResource,
  browseFilterFields,
  SIMILARITY_RESOURCES,
  PRODUCT_SIMILARITY_FIELDS,
  UNIT_OPTIONS,
  unitOptionFromText,
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
  resourceTabCondition,
  validateStatusChange,
  normalizePhoneImportText,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { WAREHOUSE_PRODUCT_FIELDS, isWarehouseMode } from './warehouse-mode';
import { CryptoService } from '../common/crypto.service';
import { AuditLog, Department, ResourceChangeLog, ResourceImportBackup, ResourceLink, ResourceRecord, User } from '../entities';
import { FileInfo, FilesService } from '../integrations/files.service';
import { deriveStoreFunds } from './store-funds';
import { deriveBankBalances } from './bank-balance';
import { deriveWorkforce } from './workforce-rules';
import { applyViewFilter, bindPhoneStores, derivePhoneFields, isViewFilter, mapLicenseByCreditCode } from './account-views';
import { applyCond, deriveColumns } from './def-conditions';
import { deriveAccountFields, hasAccountDerive } from './account-derive';
import { relationFieldLabel, relationSummary } from './relation-summary';
import { categoryAllowedForSave, categoryFromText, categoryLabels, categoryOptionsFor } from './category-options';
import { certImportMatch } from './entity-rules';
import { optionsKindOf, parseColFilters, readTimeKeys, STATUS_COL, type ColFilter } from '@kudesi/shared';
import { applyColFilters } from './col-filter.sql';
import { dynamicOptionsFor, loadUnitLists, seedUnitDefaults, unitLabel, unitValueFromText, optionsPayload, type UnitLists } from './unit-options';
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
  /** 仓库角色模式：只给了精简列、不含日志和关联（旧仓库档案视图） */
  warehouseMode?: boolean;
  createdAt: Date;
  updatedAt: Date;
  version?: string;
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
  /** 列筛选：JSON 数组 [{key, op, value?, value2?, values?}]，多列之间“并且”；规则见 shared/col-filter.ts */
  colFilters?: string;
  /** 按这个字段排序（文本/数字/金额/日期/选项字段）；不传用默认顺序 */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  /** 只要这些记录（导出所选等） */
  ids?: number[];
  /** 导出时额外带上的派生列 key（按列表当前列设置） */
  derivedKeys?: string[];
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

/** 页签条件（别名 r）：拆出的页签（如外购成品的原装采购 / 供应商 OEM）还要按拆分字段筛，default 页签把没填的也算上 */
function applyTabFilter(qb: SelectQueryBuilder<ResourceRecord>, def: ResourceDef, tab: string | undefined) {
  if (tab?.startsWith('q:')) {
    const qt = def.quickTabs?.find((t) => `q:${t.key}` === tab);
    if (!qt) throw new BadRequestException('页签不存在');
    applyCond(qb, def, qt.when, 'qt');
    return;
  }
  const c = resourceTabCondition(def, tab ?? '');
  if (!c) return;
  qb.andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${c.field}')) = :tab`, { tab: c.value });
  if (!c.split) return;
  const x = `JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${c.split.field}'))`;
  qb.andWhere(c.split.orMissing ? `(${x} = :splitTab OR ${x} IS NULL OR ${x} = '' OR ${x} NOT IN (:...splitOthers))` : `${x} = :splitTab`, { splitTab: c.split.value, splitOthers: (def.tabSplit?.options ?? []).filter((o) => o.value !== c.split!.value).map((o) => o.value) });
}

/** 页签统计用的分组表达式：和 applyTabFilter 同一口径 */
function tabExpression(def: ResourceDef): string {
  const base = `JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${def.tabsBy}'))`;
  const split = def.tabSplit;
  if (!split) return base;
  const x = `JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${split.field}'))`;
  const list = split.options.map((o) => `'${o.value.replace(/'/g, '')}'`).join(',');
  return `CASE WHEN ${base} = '${split.tab.replace(/'/g, '')}' THEN IF(${x} IN (${list}), ${x}, '${split.default.replace(/'/g, '')}') ELSE ${base} END`;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 哪些资料带“手机号文字 + 手机号档案”这一对字段（总览数据问题里的“未建档手机号”）。 */
const PHONE_FACT_FIELDS: Record<string, { numberKey: string; idKey: string; holderKey?: string }> = {
  stores: { numberKey: 'phoneNumber', idKey: 'phoneId' },
  'bank-accounts': { numberKey: 'reservedPhoneNumber', idKey: 'phoneId', holderKey: 'reservedPhoneHolder' },
  wechat: { numberKey: 'phoneNumber', idKey: 'phoneId' },
  'self-media': { numberKey: 'phoneNumber', idKey: 'phoneId' },
  partners: { numberKey: 'cardPhone', idKey: 'cardPhoneId', holderKey: 'cardPhoneHolder' },
};

/** 记录版本：内容一变就变（不靠只有秒精度的 updatedAt），表格编辑保存时用来发现别人改过 */
export function recordVersion(r: ResourceRecord): string {
  return createHash('sha1').update(JSON.stringify([r.title, r.status, r.data, r.secrets, r.archivedAt ? 1 : 0, r.updatedAt ? new Date(r.updatedAt).getTime() : 0])).digest('hex').slice(0, 16);
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

  private uniqueKeyOf(def: ResourceDef, value: unknown, data?: Record<string, unknown>): string | null {
    const key = toUniqueKey(def, value);
    // 24 号分类名称按所属档案类型和上级目录区分；旧唯一键由分类规则一并检查。
    if (key && def.key === 'finance-categories' && data) return `${data.archiveType}:${Number(data.parentId) || 0}:${key}`;
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
      version: recordVersion(r),
    };
  }

  private async toDtos(em: EntityManager, user: AuthUser, def: ResourceDef, records: ResourceRecord[]) {
    const companyId = user.companyId;
    const restricted = restrictedFieldKeys(def, createChecker(user.permissions));
    // 仓库角色模式：商品档案只给精简列（成本价格另由字段权限脱敏）
    const warehouseKeep = def.key === 'finance-products' && (await isWarehouseMode(em, user)) ? new Set(WAREHOUSE_PRODUCT_FIELDS) : null;
    const labels = await this.refLabelsFor(em, companyId, def, records);
    const fileIds = records.flatMap((r) =>
      def.fields.filter((f) => f.type === 'files').flatMap((f) => (Array.isArray(r.data[f.key]) ? (r.data[f.key] as number[]) : [])),
    );
    const fileMap = await this.files.info(companyId, fileIds);
    // 手机号的“绑定店铺 / 主子卡”：读时从店铺档案和主卡字段算，不存库
    const derived = def.key === 'phones' ? await derivePhoneFields(em, companyId, records, (r) => labels.get(r.id)?.parentPhoneId) : def.key === 'stores' ? await deriveStoreFunds(em, companyId, records) : def.key === 'bank-accounts' ? await deriveBankBalances(em, companyId, records) : null;
    const derivedCols = def.derivedColumns?.length ? await deriveColumns(em, companyId, def, records) : null;
    const workforce = def.key === 'workforce' ? await deriveWorkforce(em, companyId, records) : null;
    const accountCols = hasAccountDerive(def) ? await deriveAccountFields(em, companyId, def, records) : null;
    return records.map((r) => {
      const dto = this.toDto(def, r, labels.get(r.id) ?? {}, fileMap);
      const acc = accountCols?.get(r.id);
      if (acc) { Object.assign(dto.data, acc.data); Object.assign(dto.refLabels, acc.labels); }
      if (def.fields.some((f) => f.key === 'passwordState')) dto.data.passwordState = dto.secretConfigured.password ? '已维护' : '未设置';
      if (workforce) Object.assign(dto.data, workforce.get(r.id) ?? {});
      if (derivedCols) Object.assign(dto.data, derivedCols.get(r.id) ?? {});
      if (derived) for (const [k, v] of Object.entries(derived.get(r.id) ?? {})) { if (v !== undefined) dto.data[k] = v; else if (def.key === 'stores') delete dto.data[k]; }
      // 成本等受限字段：没有权限的人，接口里就没有（不是前端隐藏）
      for (const k of restricted) {
        delete dto.data[k];
        delete dto.refLabels[k];
        delete dto.secretConfigured[k];
      }
      if (warehouseKeep) {
        for (const k of Object.keys(dto.data)) if (!warehouseKeep.has(k)) delete dto.data[k];
        for (const k of Object.keys(dto.refLabels)) if (!warehouseKeep.has(k)) delete dto.refLabels[k];
        dto.secretConfigured = {};
        dto.warehouseMode = true;
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
    options: { status?: string; note?: string; cleanup?: string[]; logAction?: string; reason?: string } = {},
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
    const unitOptions = def.fields.some((f) => f.optionsFrom)
      ? dynamicOptionsFor(def, await loadUnitLists(em, user.companyId), { ...(existing?.data ?? {}), ...input })
      : undefined;
    // 页签分类：代码选项 + 本公司自建分类（按公司隔离）
    const categoryOptions = await categoryAllowedForSave(em, user.companyId, def, input[def.tabsBy ?? '']);
    const dynamicOptions = unitOptions || categoryOptions ? { ...unitOptions, ...categoryOptions } : undefined;
    const { values, errors } = validateResourceInput(def, input, { status, existing: existingForValidation, dynamicOptions });
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

    const rule = { em, host: this, user, data, existing, status, hasSensitive: (key: string) => Boolean(secrets[key]) };
    await beforeSaveRule(def.key, rule);
    status = rule.status;
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
        : this.uniqueKeyOf(def, data[def.uniqueField], data);
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
    await afterSaveRule(def.key, { em, host: this, user, record, existing: before, plain: values, reason: options.reason });
    return record;
  }

  /** 整批恢复数据后，按记录现在的字段重建它的引用关系 */
  async resyncLinks(em: EntityManager, user: AuthUser, type: string, id: number) {
    const rec = await em.findOneOrFail(ResourceRecord, { where: { id, companyId: user.companyId, type } });
    await this.syncLinks(em, user, this.def(type), rec);
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
    const direct = await em.findOne(ResourceRecord, { where: { companyId, type, uniqueKey: In(keys) } });
    if (type !== 'finance-categories') return direct;
    const rows = await em.find(ResourceRecord, { where: { companyId, type, archivedAt: IsNull() } });
    const byId = new Map(rows.map(r => [r.id, r]));
    const path = (row: ResourceRecord) => {
      const names: string[] = [], seen = new Set<number>();
      for (let r: ResourceRecord | undefined = row; r && !seen.has(r.id); r = byId.get(Number(r.data.parentId))) { seen.add(r.id); names.unshift(String(r.data.name)); }
      return names.join(' / ');
    };
    const matches = rows.filter(r => [String(r.data.name), path(r), `${r.data.archiveType} / ${path(r)}`].some(v => toUniqueKey(def, v) === raw));
    if (matches.length > 1) throw new ConflictException('分类名称对应多个目录，请填写完整分类路径');
    return matches[0] ?? null;
  }

  async createRecord(em: EntityManager, user: AuthUser, type: string, values: Record<string, unknown>, note?: string) {
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    return this.saveRecord(em, user, this.def(type), null, clean, { note });
  }

  async unitOptions(user: AuthUser) {
    return optionsPayload(await loadUnitLists(this.dataSource.manager, user.companyId));
  }

  async seedUnitDefaults(user: AuthUser) {
    const added = await this.dataSource.transaction((em) => seedUnitDefaults(em, user.companyId, (values) => this.createRecord(em, user, 'finance-product-units', values, '导入默认项')));
    return { added };
  }

  /** 在调用方的事务里修改一条记录，走与手工修改完全相同的校验、日志、关联流程（批量导入用，权限由调用方检查） */
  async updateRecord(em: EntityManager, user: AuthUser, type: string, id: number, values: Record<string, unknown>, note?: string) {
    const existing = await this.load(em, user, type, id);
    if (existing.archivedAt) throw new ConflictException('这条资料已归档，请先恢复再修改');
    return this.saveRecord(em, user, this.def(type), existing, values, { note });
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
  async patchData(em: EntityManager, user: AuthUser, type: string, id: number, patch: Record<string, unknown>, note?: string, syncRefs = false) {
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
      uniqueKey = this.uniqueKeyOf(def, data[def.uniqueField], data);
      if (uniqueKey) {
        const clash = await em.findOne(ResourceRecord, { where: { companyId: user.companyId, type, uniqueKey } });
        if (clash && clash.id !== id) throw new ConflictException(`「${String(data[def.uniqueField])}」已存在，请先处理重复的编码`);
      }
    }
    Object.assign(record, { data, title, uniqueKey, searchText: this.buildSearchText(def, data, title), updatedBy: user.id });
    await em.save(ResourceRecord, record);
    if (syncRefs && def.fields.some((f) => f.type === 'ref' && f.key in patch)) await this.syncLinks(em, user, def, record);
    await this.writeLog(em, user, def, id, 'update', before, record, note);
  }

  /** 读一条记录里加密字段（证件号/卡号）的明文，只给规则在服务端内部用。 */
  sensitiveOf(record: ResourceRecord, field: string): string | undefined {
    const token = this.readSecrets(record)[field];
    if (!token) return undefined;
    try { return this.crypto.decrypt(token); } catch { return undefined; }
  }

  /** 规则里改别的记录的加密字段（如银行账户为准，回写执照上登记的公户号）；value 为空即清除。 */
  async setSensitive(em: EntityManager, user: AuthUser, type: string, id: number, field: string, value: string | null, note?: string) {
    const def = this.def(type);
    const record = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type } });
    if (!record) return;
    const secrets = this.readSecrets(record);
    const old = this.sensitiveOf(record, field);
    if ((value || undefined) === old) return;
    if (value) secrets[field] = this.crypto.encrypt(value); else delete secrets[field];
    const before = { ...record, data: { ...record.data } } as ResourceRecord;
    record.secrets = Object.keys(secrets).length ? JSON.stringify(secrets) : null;
    record.updatedBy = user.id;
    await em.save(ResourceRecord, record);
    await this.writeLog(em, user, def, id, 'update', before, record, note ?? '同步了证件号/卡号类字段');
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
    const colFilters = await this.parseColFilterParam(user, def, q.colFilters);
    const restricted = restrictedFieldKeys(def, createChecker(user.permissions));

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
      // 最紧急（到期最早、已过期的在最前）排在前面
      const due = (await this.expiring(user, 30, true)).rows.filter((r) => r.type === type).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      expiringIds = [...new Set(due.map((r) => r.id))];
      if (!expiringIds.length) expiringIds = [0];
    }

    const base = (forceHidden = false) => {
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
      } else if (!q.showHidden && !forceHidden && hiddenStatuses.length > 0) {
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
        if (restricted.has(f.key)) throw new ForbiddenException(`没有权限按“${f.label}”筛选`);
        const ids = catIds.get(key);
        if (ids && f.type === 'refs') qb.andWhere(`JSON_OVERLAPS(JSON_EXTRACT(r.data, '$.${f.key}'), CAST(:fi${i} AS JSON))`, { [`fi${i}`]: JSON.stringify(ids) });
        else if (ids) qb.andWhere(`CAST(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${f.key}')) AS UNSIGNED) IN (:...fi${i})`, { [`fi${i}`]: ids });
        else qb.andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${f.key}')) = :fv${i}`, { [`fv${i}`]: val });
      });
      applyColFilters(qb, def, colFilters);
      return qb;
    };

    const quickTab = q.tab?.startsWith('q:') ? def.quickTabs?.find((t) => `q:${t.key}` === q.tab) : undefined;
    const listQb = base(Boolean(quickTab?.includeHidden));
    for (const [i, [k, v]] of viewPairs.entries()) {
      if (!(await applyViewFilter(listQb, em, user.companyId, type, k, v, todayShanghai(), i))) throw new BadRequestException('筛选条件不合法');
    }
    applyTabFilter(listQb, def, q.tab);
    const derivedSort = q.sortBy ? def.derivedColumns?.find((d) => d.key === q.sortBy) : undefined;
    const sortF = q.sortBy && !derivedSort ? def.fields.find((f) => f.key === q.sortBy) : undefined;
    if (sortF && restricted.has(sortF.key)) throw new ForbiddenException(`没有权限按“${sortF.label}”排序`);
    if (q.sortBy && !derivedSort && (!sortF || !['text', 'textarea', 'number', 'money', 'date', 'monthday', 'select'].includes(sortF.type))) throw new BadRequestException('这个字段不能排序');
    if (sortF) {
      const dir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
      const numeric = sortF.type === 'number' || sortF.type === 'money';
      const expr = `JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${sortF.key}'))`;
      listQb.addSelect(numeric ? `CAST(${expr} AS DECIMAL(30,6))` : expr, 'sortv').orderBy('sortv', dir).addOrderBy('r.id', 'DESC');
    } else if (def.sortField) {
      // 经营数据这类按日期倒序；日期是 YYYY-MM-DD，按文本排序即可
      listQb.addSelect(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${def.sortField}'))`, 'sortv').orderBy('sortv', 'DESC').addOrderBy('r.id', 'DESC');
    } else if (expiringIds && expiringIds.length > 1) {
      listQb.addSelect(`FIELD(r.id, ${expiringIds.map((n) => Math.floor(Number(n))).join(',')})`, 'ordv').orderBy('ordv', 'ASC').addOrderBy('r.id', 'DESC');
    } else {
      listQb.orderBy('r.id', 'DESC');
    }
    let records: ResourceRecord[];
    let total: number;
    if (derivedSort) {
      // 派生列排序：先算出全部符合条件记录的统计值再排（最多 5000 条），再取这一页
      const all = await listQb.orderBy('r.id', 'DESC').limit(5000).getMany();
      const vals = await deriveColumns(em, user.companyId, def, all);
      const dir = q.sortDir === 'asc' ? 1 : -1;
      all.sort((a, b) => dir * ((vals.get(a.id)?.[derivedSort.key] ?? 0) - (vals.get(b.id)?.[derivedSort.key] ?? 0)) || b.id - a.id);
      total = all.length;
      records = all.slice((page - 1) * pageSize, page * pageSize);
    } else {
      [records, total] = await Promise.all([
        listQb.offset((page - 1) * pageSize).limit(pageSize).getMany(),
        listQb.getCount(),
      ]);
    }

    let tabCounts: Record<string, number> | undefined;
    if (def.quickTabs?.length) {
      tabCounts = {};
      for (const t of def.quickTabs) {
        const cq = base(Boolean(t.includeHidden));
        for (const [i, [k, v]] of viewPairs.entries()) await applyViewFilter(cq, em, user.companyId, type, k, v, todayShanghai(), i);
        applyCond(cq, def, t.when, 'qc');
        tabCounts[`q:${t.key}`] = await cq.getCount();
      }
    }
    if (def.tabsBy) {
      const countQb = base();
      for (const [i, [k, v]] of viewPairs.entries()) await applyViewFilter(countQb, em, user.companyId, type, k, v, todayShanghai(), i);
      const rows = await countQb
        .select(tabExpression(def), 'tab')
        .addSelect('COUNT(*)', 'n')
        .groupBy('tab')
        .getRawMany<{ tab: string | null; n: string }>();
      tabCounts = tabCounts ?? {};
      for (const row of rows) tabCounts[row.tab ?? ''] = Number(row.n);
    }

    let archivedCount: number | undefined;
    if (archivePolicyOf(type)) {
      archivedCount = await em.count(ResourceRecord, { where: { companyId: user.companyId, type, archivedAt: Not(IsNull()) } });
    }
    return { items: await this.toDtos(em, user, def, records), total, page, pageSize, tabCounts, archivedCount };
  }

  /**
   * 列筛选参数 → 校验过的条件。字段必须属于该资料、当前用户看得见（成本等受限字段、仓库精简视图之外的字段一律拒绝，
   * 免得用筛选结果去猜看不到的值）；操作符、值的规则见 shared/col-filter.ts。
   */
  private async parseColFilterParam(user: AuthUser, def: ResourceDef, text: string | undefined): Promise<ColFilter[]> {
    if (!text) return [];
    const restricted = restrictedFieldKeys(def, createChecker(user.permissions));
    const allowedKeys = def.key === 'finance-products' && (await isWarehouseMode(this.dataSource.manager, user)) ? new Set(WAREHOUSE_PRODUCT_FIELDS) : undefined;
    const r = parseColFilters(text, { fields: def.fields, restricted, computed: readTimeKeys(def.key), statuses: def.statuses.map((s) => s.value), allowedKeys });
    if (!r.ok) throw new BadRequestException(r.error);
    return r.filters;
  }

  /**
   * 单选列/状态列筛选浮层里的“值 + 数量”：数量按其它列的筛选条件算（本列自己的条件不算，这样能看到还可以勾选什么）。
   * 只统计到公司、资料类型、是否归档、是否含停用，不含页签/状态/搜索词，所以是“这一列各值一共多少条”的参考数。
   */
  async columnFacets(user: AuthUser, type: string, q: { key: string; colFilters?: string; showHidden?: boolean; archived?: boolean }) {
    const def = this.def(type);
    const restricted = restrictedFieldKeys(def, createChecker(user.permissions));
    let expr = 'r.status';
    if (q.key !== STATUS_COL) {
      const f = def.fields.find((x) => x.key === q.key);
      if (!f || f.type !== 'select' || f.multi || !/^[A-Za-z0-9_]+$/.test(f.key)) throw new BadRequestException('这一列没有可统计的值');
      if (restricted.has(f.key)) throw new ForbiddenException(`没有权限按“${f.label}”筛选`);
      expr = `JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${f.key}'))`;
    }
    const filters = (await this.parseColFilterParam(user, def, q.colFilters)).filter((f) => f.key !== q.key);
    const qb = this.dataSource.manager.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :companyId AND r.type = :type', { companyId: user.companyId, type });
    qb.andWhere(q.archived ? 'r.archivedAt IS NOT NULL' : 'r.archivedAt IS NULL');
    const hidden = def.statuses.filter((s) => s.hidden).map((s) => s.value);
    if (!q.archived && !q.showHidden && hidden.length) qb.andWhere('r.status NOT IN (:...hiddenStatuses)', { hiddenStatuses: hidden });
    applyColFilters(qb, def, filters);
    const rows = await qb.select(expr, 'v').addSelect('COUNT(*)', 'n').groupBy('v').orderBy('n', 'DESC').limit(100).getRawMany<{ v: string | null; n: string }>();
    return { items: rows.filter((r) => r.v !== null && r.v !== '' && r.v !== 'null').map((r) => ({ value: String(r.v), count: Number(r.n) })) };
  }

  /** 列表左侧的分类目录：该字段所指分类树的全部节点，带各节点（含下级）下的资料数。 */
  async categoryTree(user: AuthUser, type: string, fieldKey: string, q: { tab?: string; status?: string; showHidden?: boolean }) {
    const def = this.def(type);
    const field = browseFilterFields(def).find((f) => f.key === fieldKey);
    if (!field) throw new BadRequestException('这个字段没有分类目录');
    const em = this.dataSource.manager;
    const target = field.ref!;
    if (target === 'user' || target === 'department') return this.peopleTree(user, def, field, q);
    const tdef = this.def(target);
    // 没有页签的资料（如商品组合编码）也可以按所属类型只看某一棵分类树
    const tabBy = def.tabsBy && tdef.fields.some((f) => f.key === def.tabsBy) ? def.tabsBy : (!def.tabsBy && target === 'finance-categories' ? 'archiveType' : '');
    const cats = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: target, archivedAt: IsNull() }, select: ['id', 'title', 'status', 'data'] });
    const hidden = new Set(tdef.statuses.filter((s) => s.hidden).map((s) => s.value));
    const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
    let nodes = cats.filter((c) => !hidden.has(c.status) || q.showHidden).map((c) => ({
      id: c.id, title: c.title, status: c.status, parentId: num((c.data as Record<string, unknown>).parentId), sort: Number((c.data as Record<string, unknown>).sort) || 0,
      tab: tabBy ? String((c.data as Record<string, unknown>)[tabBy] ?? '') : '',
    }));
    // 配置里声明不显示的节点（如位置目录不列“储物空间”）：只是不列出来，它们下面的资料仍沿上级链算进上级
    const exclude = def.treeExclude?.[field.key];
    if (exclude) {
      const out = new Set(cats.filter((c) => exclude.values.includes(String((c.data as Record<string, unknown>)[exclude.field] ?? ''))).map((c) => c.id));
      nodes = nodes.filter((n) => !out.has(n.id));
    }
    // 页签切换时，只显示属于这个页签的分类
    if (q.tab && tabBy) {
      const roots = def.treeTabMap?.[q.tab] ?? [q.tab];
      nodes = nodes.filter((n) => roots.includes(n.tab));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const parentOf = new Map(cats.map((c) => [c.id, num((c.data as Record<string, unknown>).parentId)]));

    const hiddenStatuses = def.statuses.filter((s) => s.hidden).map((s) => s.value);
    const qb = em.createQueryBuilder(ResourceRecord, 'r').select(['r.id', 'r.data']).where('r.companyId = :companyId AND r.type = :type AND r.archivedAt IS NULL', { companyId: user.companyId, type });
    if (q.status) qb.andWhere('r.status = :status', { status: q.status });
    else if (!q.showHidden && hiddenStatuses.length) qb.andWhere('r.status NOT IN (:...hiddenStatuses)', { hiddenStatuses });
    applyTabFilter(qb, def, q.tab);
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

  /** 列表左侧按“使用人 / 所属部门”浏览：每个有资料的人或部门一行（不分级），带数量。 */
  private async peopleTree(user: AuthUser, def: ResourceDef, field: FieldDef, q: { tab?: string; status?: string; showHidden?: boolean }) {
    const em = this.dataSource.manager;
    const hiddenStatuses = def.statuses.filter((s) => s.hidden).map((s) => s.value);
    const qb = em.createQueryBuilder(ResourceRecord, 'r').select(['r.id', 'r.data']).where('r.companyId = :companyId AND r.type = :type AND r.archivedAt IS NULL', { companyId: user.companyId, type: def.key });
    if (q.status) qb.andWhere('r.status = :status', { status: q.status });
    else if (!q.showHidden && hiddenStatuses.length) qb.andWhere('r.status NOT IN (:...hiddenStatuses)', { hiddenStatuses });
    applyTabFilter(qb, def, q.tab);
    const records = await qb.getMany();
    const counts = new Map<number, number>();
    let uncategorized = 0;
    for (const r of records) {
      const v = (r.data as Record<string, unknown>)[field.key];
      if (typeof v !== 'number') { uncategorized++; continue; }
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const ids = [...counts.keys()];
    const named = new Map<number, { title: string; status: string }>();
    if (ids.length) {
      if (field.ref === 'user') (await em.find(User, { where: { companyId: user.companyId, id: In(ids) } })).forEach((u) => named.set(u.id, { title: u.name, status: u.status === 'active' ? 'active' : 'inactive' }));
      else (await em.find(Department, { where: { companyId: user.companyId, id: In(ids) } })).forEach((d) => named.set(d.id, { title: d.name, status: 'active' }));
    }
    return {
      field: field.key,
      total: records.length,
      uncategorized,
      nodes: ids
        .filter((id) => named.has(id))
        .map((id) => ({ id, title: named.get(id)!.title, status: named.get(id)!.status, parentId: 0, sort: 0, count: counts.get(id) ?? 0 }))
        .sort((a, b) => b.count - a.count || a.id - b.id),
    };
  }

  async get(user: AuthUser, type: string, id: number) {
    const def = this.def(type);
    const record = await this.load(this.dataSource.manager, user, type, id);
    return (await this.toDtos(this.dataSource.manager, user, def, [record]))[0];
  }

  /** 仓库角色只读商品档案，但可以给档案追加照片（只加不删，旧仓库档案视图的规则）。 */
  async addWarehousePhotos(user: AuthUser, id: number, fileIds: number[]) {
    const em = this.dataSource.manager;
    if (!(await isWarehouseMode(em, user))) throw new ForbiddenException('只有仓库岗位用这个入口上传照片，其他人请直接修改商品档案');
    const def = this.def('finance-products');
    const cap = def.fields.find((f) => f.key === 'photos')?.maxFiles ?? 20;
    await this.dataSource.transaction(async (tx) => {
      const record = await this.load(tx, user, 'finance-products', id);
      if (record.archivedAt) throw new ConflictException('这条资料已归档，不能再上传');
      const old = Array.isArray(record.data.photos) ? (record.data.photos as number[]) : [];
      const add = [...new Set(fileIds)].filter((x) => !old.includes(x));
      if (!add.length) return;
      if (old.length + add.length > cap) throw new BadRequestException(`最多 ${cap} 张照片`);
      await this.files.verify(tx, user.companyId, 'finance-products', 'photos', add, null);
      await this.files.bind(tx, user.companyId, id, add);
      await this.patchData(tx, user, 'finance-products', id, { photos: [...old, ...add] }, '仓库岗位上传了商品照片');
    });
    return this.get(user, 'finance-products', id);
  }

  async create(user: AuthUser, type: string, values: Record<string, unknown>, status?: string) {
    const def = this.def(type);
    const cleanup: string[] = [];
    const record = await this.dataSource.transaction((em) => this.saveRecord(em, user, def, null, values, { status, cleanup }));
    await this.files.deleteObjects(user.companyId, cleanup);
    return this.get(user, type, record.id);
  }

  async update(user: AuthUser, type: string, id: number, values: Record<string, unknown>, note?: string) {
    const def = this.def(type);
    const cleanup: string[] = [];
    await this.dataSource.transaction(async (em) => {
      const existing = await this.load(em, user, type, id);
      if (existing.archivedAt) throw new ConflictException('这条资料已归档，请先恢复再修改');
      await this.saveRecord(em, user, def, existing, values, { cleanup, note });
    });
    await this.files.deleteObjects(user.companyId, cleanup);
    return this.get(user, type, id);
  }

  /** 同级排序整体提交；锁定本公司目录，同一事务更新，失败不会只保存一半。 */
  async reorderCategories(user: AuthUser, type: string, orderedIds: number[]) {
    if (!['finance-categories','finance-supplier-categories','finance-customer-categories','finance-fee-categories'].includes(type)) throw new BadRequestException('这类资料不支持分类排序');
    if (orderedIds.length < 2 || new Set(orderedIds).size !== orderedIds.length) throw new BadRequestException('请选择至少两个不重复的分类');
    return this.dataSource.transaction(async em => {
      const all = await em.createQueryBuilder(ResourceRecord,'r').where('r.companyId = :companyId AND r.type = :type AND r.archivedAt IS NULL',{companyId:user.companyId,type}).orderBy('r.id','ASC').setLock('pessimistic_write').getMany();
      const byId = new Map(all.map(r=>[r.id,r]));
      const selected = orderedIds.map(id=>byId.get(id));
      if (selected.some(r=>!r)) throw new BadRequestException('有分类不存在');
      const first = selected[0]!, parentId=Number(first.data.parentId)||0;
      const sameScope=(r:ResourceRecord)=> (Number(r.data.parentId)||0)===parentId && (type!=='finance-categories'||r.data.archiveType===first.data.archiveType);
      if(selected.some(r=>!sameScope(r!)))throw new BadRequestException('只能调整同一个上级下的分类顺序');
      const siblings=all.filter(sameScope).sort((a,b)=>Number(a.data.sort||0)-Number(b.data.sort||0)||a.id-b.id);
      const picked=new Set(orderedIds),slots=siblings.map((r,i)=>picked.has(r.id)?i:-1).filter(i=>i>=0),next=siblings.map(r=>r.id);
      slots.forEach((slot,i)=>{next[slot]=orderedIds[i];});
      let changed=0;
      for(const [i,id] of next.entries())if(Number(byId.get(id)!.data.sort)!==(i+1)*10){await this.patchData(em,user,type,id,{sort:(i+1)*10},'调整分类顺序');changed++;}
      return {ok:true,changed};
    });
  }

  async saveArchivePrefix(user: AuthUser, type: string, archiveType: string, code: string) {
    if (type !== 'finance-categories') throw new BadRequestException('这里只能维护商品档案类型编号');
    const id = await this.dataSource.transaction(async em => {
      const existing = await em.findOne(ResourceRecord, {where:{companyId:user.companyId,type:'finance-archive-prefixes',uniqueKey:archiveType.toLowerCase(),archivedAt:IsNull()}});
      const row = existing ? await this.updateRecord(em,user,'finance-archive-prefixes',existing.id,{code},'调整档案类型编号') : await this.createRecord(em,user,'finance-archive-prefixes',{archiveType,code},'设置档案类型编号');
      return row.id;
    });
    return this.get(user,'finance-archive-prefixes',id);
  }

  /** 组合基础资料与启停同事务保存，编码和构成继续由专门动作维护。 */
  async confirmBundleProfile(user: AuthUser, type: string, id: number, values: Record<string, unknown>) {
    if (Object.keys(values).some(k => !['name', 'shortName', 'status', 'statusReason'].includes(k))) throw new BadRequestException('组合基础资料只能修改名称、简称和状态');
    if (typeof values.name !== 'string' || !values.name.trim() || typeof values.shortName !== 'string' || !values.shortName.trim()) throw new BadRequestException('商品名称和商品简称必填');
    if (!['active', 'inactive'].includes(String(values.status))) throw new BadRequestException('请选择启用或停用');
    await this.dataSource.transaction(async em => {
      const record = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type }, lock: { mode: 'pessimistic_write' } });
      if (!record) throw new NotFoundException('记录不存在');
      if (record.archivedAt || record.status === 'archived') throw new ConflictException('这条资料已归档，请先恢复再修改');
      const status = values.status === 'inactive' ? 'inactive' : record.status === 'inactive' ? 'pending' : record.status;
      if (status !== record.status && !createChecker(user.permissions)(resourcePermission(type, 'disable'))) throw new ForbiddenException('没有改状态的权限');
      const reason = String(values.statusReason ?? '').trim();
      if (status !== record.status) {
        const problem = validateStatusChange(this.def(type), status, reason);
        if (problem) throw new BadRequestException(problem);
      }
      if (em.queryRunner) em.queryRunner.data.bundleProfile = true;
      const input = { manualName: String(values.name).trim(), manualShortName: String(values.shortName).trim(), manualReason: String(record.data.manualReason || '编辑组合基础资料') };
      const saved = await this.saveRecord(em, user, this.def(type), record, input, { status, reason, note: '编辑商品组合编码基础资料' });
      if (status !== record.status) {
        const fresh = await this.load(em, user, type, saved.id);
        fresh.statusReason = status === 'inactive' ? reason : null;
        await em.save(ResourceRecord, fresh);
      }
    });
    return this.get(user, type, id);
  }

  /** 专属编辑界面的明确核对动作；沿用资料保存的全部规则，不接受来源、成本或同步字段。 */
  async confirmBaseProfile(user: AuthUser, type: string, id: number, values: Record<string, unknown>) {
    if (type === 'finance-bundles') return this.confirmBundleProfile(user, type, id, values);
    if (type !== 'finance-base-codes') throw new BadRequestException('这类资料没有基础编码专属资料');
    const allowed = new Set(['code', 'styleCode', 'name', 'shortName', 'spec', 'categoryId', 'weightG', 'codeChangeReason']);
    if (Object.keys(values).some(k => !allowed.has(k))) throw new BadRequestException('专属资料只能修改编码、名称、简称、规格、分类和重量');
    await this.dataSource.transaction(async em => {
      const record = await this.load(em, user, type, id);
      if (record.archivedAt) throw new ConflictException('这条资料已归档，请先恢复再修改');
      if (em.queryRunner) em.queryRunner.data.confirmBaseProfile = true;
      await this.saveRecord(em, user, this.def(type), record, values, { note: '核对并保存商品基础编码专属资料' });
    });
    return this.get(user, type, id);
  }

  /**
   * 表格编辑的单行保存（独立事务）：与单条新建/修改走同一个 saveRecord（字段校验、唯一性、特殊规则、引用、审计日志）。
   * 修改时带 version：记录已被别人改过则返回 409，不覆盖。
   */
  async saveGridRow(user: AuthUser, type: string, row: { id?: number; version?: string; values: Record<string, unknown>; status?: string; statusReason?: string }, note: string) {
    const def = this.def(type);
    const cleanup: string[] = [];
    const record = await this.dataSource.transaction(async (em) => {
      if (row.id === undefined) return this.saveRecord(em, user, def, null, row.values, { cleanup, note });
      const existing = await em.findOne(ResourceRecord, { where: { id: row.id, companyId: user.companyId, type }, lock: { mode: 'pessimistic_write' } });
      if (!existing) throw new NotFoundException('记录不存在');
      if (existing.archivedAt) throw new ConflictException('这条资料已归档，请先恢复再修改');
      if (row.version && row.version !== recordVersion(existing)) throw new ConflictException('这条资料刚被别人修改过，请刷新后再改');
      if (!row.status || row.status === existing.status) return this.saveRecord(em, user, def, existing, row.values, { cleanup, note });
      // 字段和状态在同一个事务里一起保存：状态校验、状态相关字段的清理、原因记录和日志与单条“改状态”一致
      const problem = validateStatusChange(def, row.status, row.statusReason);
      if (problem) throw new BadRequestException(problem);
      const reason = row.statusReason?.trim();
      const abnormalInput: Record<string, unknown> = {};
      if (row.status === 'abnormal' && reason) {
        if (def.fields.some((f) => f.key === 'abnormalReasonText')) abnormalInput.abnormalReasonText = reason.slice(0, 100);
        else if (def.fields.some((f) => f.key === 'abnormalReason' && f.type !== 'ref')) abnormalInput.abnormalReason = reason.slice(0, 2000);
      }
      const saved = await this.saveRecord(em, user, def, existing, { ...abnormalInput, ...row.values }, { cleanup, note: `${note}；状态：${existing.status} → ${row.status}${reason ? `（${reason}）` : ''}`, status: row.status, reason });
      const fresh = await this.load(em, user, type, saved.id);
      fresh.statusReason = def.statuses.find((s) => s.value === row.status)?.requiresReason ? reason!.slice(0, 500) : null;
      await em.save(ResourceRecord, fresh);
      return fresh;
    });
    await this.files.deleteObjects(user.companyId, cleanup);
    return record.id;
  }

  /** 表格编辑：按列表同样的口径把若干条记录转成返回给前端的行 */
  async gridRows(user: AuthUser, type: string, ids: number[]) {
    if (!ids.length) return [];
    const def = this.def(type);
    const records = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type, id: In(ids) } });
    return this.toDtos(this.dataSource.manager, user, def, records);
  }

  /** 表格编辑归档前核对版本（归档本身仍走 archive） */
  async gridVersionOf(user: AuthUser, type: string, id: number) {
    const r = await this.dataSource.manager.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type } });
    if (!r) throw new NotFoundException('记录不存在');
    return recordVersion(r);
  }

  /** 往来档案（供应商、客户）保存前的相似/重复检测 */
  async similarCheck(user: AuthUser, type: string, values: Record<string, unknown>, excludeId?: number) {
    if (!SIMILARITY_RESOURCES.includes(type)) throw new BadRequestException('这类资料不做相似检测');
    const rows = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type }, select: ['id', 'data'] });
    const isProduct = type === 'finance-products';
    // 商品档案只和同一档案类型的比，且已删除/归档的不算
    let pool = isProduct ? rows.filter((x) => x.data.archiveType === values.archiveType) : rows;
    let cand = values;
    if (isProduct) {
      // 品牌、规格单位显示成名称，比较提示里才看得懂
      const brands = new Map((await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-brands' }, select: ['id', 'title'] })).map((b) => [b.id, b.title] as const));
      const unitLabel = (v: unknown) => UNIT_OPTIONS.find((u) => u.value === v)?.label ?? v;
      const readable = (d: Record<string, unknown>) => ({ ...d, brandId: brands.get(Number(d.brandId)) ?? '', specUnit: unitLabel(d.specUnit) });
      cand = readable(values);
      pool = pool.map((x) => ({ ...x, data: readable(x.data) }) as ResourceRecord);
    }
    const r = inspectArchiveSimilarity(cand, pool.map((x) => ({ id: x.id, data: x.data })), excludeId, isProduct ? PRODUCT_SIMILARITY_FIELDS : undefined);
    // 商品编码是自动生成、本来就不会相同，“已填字段完全相同”在商品上只提示（需确认），不直接拦截
    if (isProduct) return { blocked: [], warnings: [...r.blocked, ...r.warnings].slice(0, 6).map((m) => ({ ...m, text: formatSimilarityMatch(m) })) };
    return { blocked: r.blocked.slice(0, 6).map((m) => ({ ...m, text: formatSimilarityMatch(m) })), warnings: r.warnings.slice(0, 6).map((m) => ({ ...m, text: formatSimilarityMatch(m) })) };
  }

  /** 批量改字段（仅限资料定义里声明的 batch 字段）或批量改状态；逐条走统一保存流程，失败的单独返回 */
  /** 带原因的批量动作（资料配置 batchActions）：固定值 + 用户选的值 + 原因，逐条走正常保存流程 */
  async batchAction(user: AuthUser, type: string, ids: number[], actionKey: string, value: unknown, reason?: string) {
    const def = this.def(type);
    const action = def.batchActions?.find((a) => a.key === actionKey);
    if (!action) throw new BadRequestException('不支持这个批量操作');
    const text = (reason ?? '').trim();
    if (action.reasonRequired && !text) throw new BadRequestException(`请填写${action.reasonLabel ?? '原因'}`);
    const values: Record<string, unknown> = { ...(action.set ?? {}) };
    if (action.pick) {
      if (value === undefined || value === null || value === '') throw new BadRequestException('请先选择要设置的值');
      values[action.pick] = value;
    }
    if (action.reasonField && text) values[action.reasonField] = text;
    return this.batchUpdate(user, type, ids, values, undefined, undefined, { trusted: true, note: text ? `${action.label}：${text}` : action.label });
  }

  async batchUpdate(user: AuthUser, type: string, ids: number[], values: Record<string, unknown>, status?: string, reason?: string, opts: { trusted?: boolean; note?: string } = {}) {
    const def = this.def(type);
    // 批量停用/启用：所有资料都可以（逐条走 changeStatus，状态是否合法、原因、归档、停用权限都在那里校验）
    const allowed = def.batch ?? [];
    const keys = Object.keys(values);
    if (!keys.length && !status) throw new BadRequestException('请选择要批量修改的内容');
    if (status && !allowed.includes('status')) {
      const st = def.statuses.find((x) => x.value === status);
      if (!st) throw new BadRequestException('状态不合法');
      if (!st.hidden && status !== def.defaultStatus) throw new BadRequestException('这类资料只能批量停用或启用');
    }
    if (!opts.trusted) {
      if (keys.length && !allowed.length) throw new BadRequestException('这类资料不支持批量修改');
      for (const k of keys) if (!allowed.includes(k)) throw new BadRequestException('不能批量修改这个字段');
    }
    const uniq = [...new Set(ids)];
    if (!uniq.length) throw new BadRequestException('请先勾选要修改的记录');
    let done = 0;
    const failed: Array<{ id: number; message: string }> = [];
    for (const id of uniq) {
      try {
        if (keys.length) await this.update(user, type, id, values, opts.note);
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
    await this.dataSource.transaction(em=>this.changeStatusRecord(em,user,type,id,status,reason));
    return this.get(user,type,id);
  }

  /** 事务组合动作使用完整的状态校验与保存流程。 */
  async changeStatusRecord(em: EntityManager, user: AuthUser, type: string, id: number, status: string, reason?: string) {
    const def = this.def(type);
    const problem = validateStatusChange(def, status, reason);
    if (problem) throw new BadRequestException(problem);
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
    await this.saveRecord(em, user, def, existing, abnormalInput, { status, note: `状态：${existing.status} → ${status}${reason ? `（${reason.trim()}）` : ''}`, reason });
    const fresh = await this.load(em, user, type, id);
    fresh.statusReason = needsReason ? reason!.trim().slice(0, 500) : null;
    await em.save(ResourceRecord, fresh);
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
    await this.dataSource.transaction(em => this.removeRecord(em,user,type,id,reason,cleanup));
    await this.files.deleteObjects(user.companyId, cleanup);
    return { ok: true };
  }

  /** 组合操作在同一事务内删除，仍执行统一引用校验和日志。 */
  async removeRecord(em: EntityManager, user: AuthUser, type: string, id: number, reason: string, cleanup: string[] = []) {
    const def = this.def(type);
    if (archivePolicyOf(type)) throw new BadRequestException('该资料应走归档流程');
    if (reason.trim().length < 2) throw new BadRequestException('删除必须填写原因');
    const existing = await this.load(em, user, type, id);
    await beforeDeleteRule(def.key, { em, host: this, user, record: existing });
    const incoming = await em.find(ResourceLink, { where: { companyId: user.companyId, targetType: type, targetId: id, relation: Not('manual') } });
    if (incoming.length > 0) {
      const sources = await em
        .createQueryBuilder(ResourceRecord, 'r')
        .select(['r.id', 'r.type', 'r.title', 'r.status', 'r.data'])
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
    if (type === 'finance-products' && (await isWarehouseMode(this.dataSource.manager, user))) return [];
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
    return l.relation === 'manual' ? { validFrom: l.validFrom, validTo: l.validTo, purpose: l.purpose, relationKind: l.relationKind } : {};
  }

  private cleanLinkProps(p: { validFrom?: string | null; validTo?: string | null; purpose?: string | null; relationKind?: string | null }, pair?: { type: string; target: string }) {
    const date = (v: unknown, label: string) => {
      if (v === undefined || v === null || v === '') return null;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new BadRequestException(`${label}格式应为 YYYY-MM-DD`);
      return v;
    };
    const validFrom = date(p.validFrom, '开始日期');
    const validTo = date(p.validTo, '结束日期');
    if (validFrom && validTo && validTo < validFrom) throw new BadRequestException('结束日期不能早于开始日期');
    const purpose = typeof p.purpose === 'string' && p.purpose.trim() ? p.purpose.trim().slice(0, 200) : null;
    const asked = typeof p.relationKind === 'string' ? p.relationKind.trim() : '';
    const relationKind = asked && isKnownRelationKind(asked, pair?.type, pair?.target) ? asked : null;
    if (asked && !relationKind && pair) throw new BadRequestException('这两类资料之间没有这种关系类型');
    return { validFrom, validTo, purpose, relationKind };
  }

  /** 这条记录指向了谁、又被谁引用。 */
  async relations(user: AuthUser, type: string, id: number, can: (permission: string) => boolean) {
    this.def(type);
    const em = this.dataSource.manager;
    await this.load(em, user, type, id);
    if (type === 'finance-products' && (await isWarehouseMode(em, user))) return [];
    const links = await em
      .createQueryBuilder(ResourceLink, 'l')
      .where('l.companyId = :c AND ((l.sourceType = :t AND l.sourceId = :id) OR (l.targetType = :t AND l.targetId = :id))', {
        c: user.companyId,
        t: type,
        id,
      })
      .getMany();
    const out: Array<{ direction: 'out' | 'in'; relation: string; relationLabel?: string; summary?: string; type: string; id: number; title: string; linkId?: number; validFrom?: string | null; validTo?: string | null; purpose?: string | null; relationKind?: string | null }> = [];
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
          .select(['r.id', 'r.type', 'r.title', 'r.status', 'r.data'])
          .where('r.companyId = :c AND r.id IN (:...ids)', { c: user.companyId, ids: [...wantRecords] })
          .getMany()
      : [];
    // 页签分类的本公司名称（自建分类、改名）：关联摘要里的分类也按本公司名称显示
    const catByType = new Map<string, Awaited<ReturnType<typeof categoryLabels>>>();
    for (const t of new Set(records.map((r) => r.type))) catByType.set(t, await categoryLabels(em, user.companyId, this.def(t)));
    for (const l of links) {
      if (l.sourceType === type && l.sourceId === id) {
        if (l.targetType === 'user') out.push({ direction: 'out', relation: l.relation, type: 'user', id: l.targetId, title: users.find((u) => u.id === l.targetId)?.name ?? `#${l.targetId}`, linkId: l.id, ...this.linkProps(l) });
        else {
          const r = records.find((x) => x.id === l.targetId && x.type === l.targetType);
          if (r) out.push({ direction: 'out', relation: l.relation, relationLabel: relationFieldLabel(type, l.relation, 'out'), summary: relationSummary(r, catByType.get(r.type)), type: r.type, id: r.id, title: r.title, linkId: l.id, ...this.linkProps(l) });
        }
      } else {
        const r = records.find((x) => x.id === l.sourceId && x.type === l.sourceType);
        if (r) out.push({ direction: 'in', relation: l.relation, relationLabel: relationFieldLabel(r.type, l.relation, 'in'), summary: relationSummary(r, catByType.get(r.type)), type: r.type, id: r.id, title: r.title, linkId: l.id, ...this.linkProps(l) });
      }
    }
    // 只给出调用者有权查看的资料类型，避免通过关联“窥探”无权限的资料
    return out.filter((x) => x.type === 'user' || can(resourcePermission(permissionOwner(x.type), 'view')));
  }

  /** 手动关联员工（如营业执照的关联运营人员）：只能关联本公司员工，同一个人不重复关联。 */
  private async addUserLink(user: AuthUser, type: string, id: number, targetId: number, clean: { validFrom?: string | null; validTo?: string | null; purpose?: string | null; relationKind?: string | null }) {
    await this.dataSource.transaction(async (em) => {
      const src = await this.load(em, user, type, id);
      const target = await em.findOne(User, { where: { id: targetId, companyId: user.companyId } });
      if (!target) throw new BadRequestException('要关联的员工不存在');
      const dup = await em.findOne(ResourceLink, { where: { companyId: user.companyId, sourceType: type, sourceId: id, targetType: 'user', targetId } });
      if (dup) throw new ConflictException('已经关联过了');
      await em.insert(ResourceLink, { companyId: user.companyId, sourceType: type, sourceId: id, relation: 'manual', targetType: 'user', targetId, ...clean });
      await this.writeLog(em, user, this.def(type), src.id, 'update', src, src, `手动关联员工「${target.name}」${clean.purpose ? `（${clean.purpose}）` : ''}`);
    });
    return { ok: true };
  }

  /** 手动关联：把另一条资料关联到这条上（一条可以关联多条，如合作人对应多个执照/店铺）。 */
  async addManualLink(user: AuthUser, type: string, id: number, targetType: string, targetId: number, can: (permission: string) => boolean, props: { validFrom?: string | null; validTo?: string | null; purpose?: string | null; relationKind?: string | null } = {}) {
    this.def(type);
    const clean = this.cleanLinkProps(props, { type, target: targetType });
    if (targetType === 'user') return this.addUserLink(user, type, id, targetId, clean);
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
  async updateManualLink(user: AuthUser, type: string, id: number, linkId: number, props: { validFrom?: string | null; validTo?: string | null; purpose?: string | null; relationKind?: string | null }) {
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
    const items: Array<{ type: string; label: string; total: number; abnormal: number; inactive: number; archived: number }> = [];
    for (const def of RESOURCE_DEFS) {
      if (!def.nav || def.nav.section || !can(resourcePermission(def.key, 'view'))) continue;
      const hidden = def.statuses.filter((s) => s.hidden).map((s) => s.value);
      const all = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: def.key }, select: ['id', 'status', 'archivedAt'] });
      const rows = all.filter((r) => !r.archivedAt);
      const active = rows.filter((r) => !hidden.includes(r.status));
      // 停用/注销 = 没归档、但处在“默认隐藏”的状态；已归档单独数
      items.push({ type: def.key, label: def.label, total: active.length, abnormal: active.filter((r) => r.status === 'abnormal').length, inactive: rows.length - active.length, archived: all.length - rows.length });
    }
    return { items };
  }

  /** 资料总览的“最近变更”：本公司最近的资料修改（只含用户有查看权限的资料类型；不含查看明文的记录）。 */
  /** 资料里只填了手机号文字、没有手机号档案时，一键建档并绑定（旧系统“建立手机号档案并绑定”）。同号码已有档案就直接绑定。同一事务，公司取自令牌。 */
  async createPhoneFor(user: AuthUser, type: string, id: number) {
    const spec = PHONE_FACT_FIELDS[type];
    if (!spec) throw new BadRequestException('这类资料没有可建档的手机号');
    const can = createChecker(user.permissions);
    if (!can(resourcePermission(permissionOwner(type), 'edit')) || !can(resourcePermission('phones', 'create'))) throw new ForbiddenException('需要该资料的修改权限和手机号档案的新增权限');
    const cleanup: string[] = [];
    const out = await this.dataSource.transaction(async (em) => {
      const rec = await this.load(em, user, type, id);
      if (rec.archivedAt) throw new ConflictException('这条资料已归档，请先恢复再修改');
      const number = String(rec.data[spec.numberKey] ?? '').trim();
      if (!number) throw new BadRequestException('这条资料没有填手机号');
      if (rec.data[spec.idKey]) throw new ConflictException('已经绑定了手机号档案');
      let phone = await this.findByUnique(em, user.companyId, 'phones', number);
      let created = false;
      if (!phone) {
        const holder = spec.holderKey ? String(rec.data[spec.holderKey] ?? '').trim() : '';
        phone = await this.saveRecord(em, user, this.def('phones'), null, { number, usageType: 'external_used', ...(holder ? { externalUser: holder } : {}) }, { note: `由${getResourceDef(type)?.label ?? type}「${rec.title}」一键建档` });
        created = true;
      }
      await this.saveRecord(em, user, this.def(type), rec, { [spec.idKey]: phone.id }, { cleanup });
      return { created, number, phoneId: phone.id };
    });
    await this.files.deleteObjects(user.companyId, cleanup);
    return out;
  }

  async recentChanges(user: AuthUser, limit = 40) {
    const can = createChecker(user.permissions);
    const em = this.dataSource.manager;
    const allowed = RESOURCE_DEFS.filter((d) => d.nav && !d.nav.section && can(resourcePermission(permissionOwner(d.key), 'view'))).map((d) => d.key);
    if (allowed.length === 0) return [];
    const take = Math.min(100, Math.max(1, Math.floor(limit) || 40));
    const logs = await em.find(ResourceChangeLog, { where: { companyId: user.companyId, resourceType: In(allowed), action: Not('reveal') }, order: { id: 'DESC' }, take });
    if (logs.length === 0) return [];
    const ids = [...new Set(logs.map((l) => l.resourceId))];
    const records = await em.find(ResourceRecord, { where: { companyId: user.companyId, id: In(ids) }, select: ['id', 'type', 'title'] });
    const titleOf = new Map(records.map((r) => [`${r.type}:${r.id}`, r.title]));
    const actors = await em.createQueryBuilder(User, 'u').select(['u.id', 'u.name']).where('u.companyId = :c AND u.id IN (:...ids)', { c: user.companyId, ids: [...new Set(logs.map((l) => l.actorId).filter((x): x is number => x != null))].concat([0]) }).getMany();
    const nameOf = new Map(actors.map((a) => [a.id, a.name]));
    return logs.map((l) => ({
      id: l.id, type: l.resourceType, typeLabel: getResourceDef(l.resourceType)?.label ?? l.resourceType, resourceId: l.resourceId,
      name: titleOf.get(`${l.resourceType}:${l.resourceId}`) ?? `#${l.resourceId}`, action: l.action, note: l.note, actor: l.actorId ? nameOf.get(l.actorId) ?? `#${l.actorId}` : '系统', createdAt: l.createdAt,
    }));
  }

  /** 即将到期 / 已过期统一列表（旧系统 expiring.js）：按每种资料的查看权限过滤；停用/注销/已归档的不提醒。 */
  async expiring(user: AuthUser, days = 30, includeExpired = true, today: string = todayShanghai()) {
    const can = createChecker(user.permissions);
    const window = Math.min(366, Math.max(0, Math.floor(Number.isFinite(days) ? days : 30)));
    const limit = addDaysText(today, window);
    const em = this.dataSource.manager;
    const sources = expirySources().filter((src) => can(resourcePermission(permissionOwner(src.resource), 'view')));
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

  private displayValue(f: FieldDef, dto: ResourceDto, units?: UnitLists, cat?: { field: string; labels: Map<string, string> }): string {
    const v = dto.data[f.key];
    if (v === undefined || v === null) return '';
    if (f.type === 'select' && f.optionsFrom && units) return unitLabel(units, optionsKindOf(f, dto.data) ?? f.optionsFrom.kind, v);
    if (f.type === 'select' && cat?.field === f.key && cat.labels.has(String(v))) return cat.labels.get(String(v))!;
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
    const fields = def.fields.filter((f) => f.type !== 'secret' && !f.listOnly && !hidden.has(f.key));
    const items: ResourceDto[] = [];
    for (let page = 1; page < 100; page++) {
      const res = await this.list(user, type, { ...scope, page, pageSize: 200, showHidden: includeHidden });
      items.push(...res.items);
      if (items.length >= res.total) break;
    }
    const units = fields.some((f) => f.optionsFrom) ? await loadUnitLists(this.dataSource.manager, user.companyId) : undefined;
    const cat = await categoryLabels(this.dataSource.manager, user.companyId, def);
    // 列表当前显示的派生列（店铺数、本月营业额等）一并导出
    const extra = (def.derivedColumns ?? []).filter((d) => (scope.derivedKeys ?? []).includes(d.key));
    const header = ['状态', ...fields.map((f) => f.label), ...extra.map((d) => d.label)];
    const lines = [header.map((h) => this.csvCell(h)).join(',')];
    for (const dto of items) {
      const status = def.statuses.find((s) => s.value === dto.status)?.label ?? dto.status;
      const extraCells = extra.map((d) => { const n = Number(dto.data[d.key] ?? 0); return d.kind === 'sum' && d.format === 'money' ? (n / 100).toFixed(2) : String(n); });
      lines.push([status, ...fields.map((f) => this.displayValue(f, dto, units, cat)), ...extraCells].map((c) => this.csvCell(c)).join(','));
    }
    return { filename: `${def.label}.csv`, csv: `﻿${lines.join('\r\n')}`, count: items.length };
  }

  /** 把一行（表头为字段中文名）转换成字段值；转换失败返回错误。 */
  /** 位置完整路径 → 记录：末级名称相同的候选里，上级链和路径逐级对得上的才算。 */
  private async locationByPath(em: EntityManager, companyId: number, path: string): Promise<ResourceRecord[]> {
    const names = path.split(/[\/>→›]/).map((x) => x.trim()).filter(Boolean);
    if (names.length < 2) return [];
    const all = await em.find(ResourceRecord, { where: { companyId, type: 'locations' }, select: ['id', 'title', 'data'] });
    const byId = new Map(all.map((r) => [r.id, r]));
    return all.filter((r) => {
      if (r.title !== names[names.length - 1]) return false;
      let cur: ResourceRecord | undefined = r;
      for (let i = names.length - 1; i >= 0; i--) {
        if (!cur || cur.title !== names[i]) return false;
        const pid: unknown = cur.data.parentId;
        cur = typeof pid === 'number' ? byId.get(pid) : undefined;
      }
      return true;
    });
  }

  private async rowToInput(
    em: EntityManager,
    user: AuthUser,
    def: ResourceDef,
    row: Record<string, string>,
  ): Promise<{ input: Record<string, unknown>; status?: string; errors: string[] }> {
    const input: Record<string, unknown> = {};
    const errors: string[] = [];
    let status: string | undefined;
    let unitLists: UnitLists | undefined;
    let catOpts: Awaited<ReturnType<typeof categoryOptionsFor>>;
    const statusText = (row['状态'] ?? '').trim();
    if (statusText) {
      status = def.statuses.find((s) => s.label === statusText || s.value === statusText)?.value;
      if (!status) errors.push(`状态“${statusText}”不认识`);
    }
    for (const f of def.fields) {
      if ((f.type === 'secret' && !f.importable) || f.type === 'files' || f.type === 'attrs' || f.readonly) continue; // 密码、文件、系统计算的字段不走导入（资质的平台登录密码除外）
      let raw = (row[f.label] ?? (f.aliases ?? []).map((a) => row[a]).find((v) => v !== undefined) ?? '').trim();
      // Excel 弄坏的手机号（="138…"、138….0、科学计数法）先还原
      if (raw && (f.type === 'phone' || (def.key === 'stores' && f.key === 'phoneNumber'))) raw = normalizePhoneImportText(raw);
      // 店铺的“所属执照”可填统一社会信用代码
      if (raw && f.type === 'ref' && f.ref === 'licenses') raw = await mapLicenseByCreditCode(em, user.companyId, raw);
      if (!raw) continue;
      const unitKind = f.type === 'select' && f.optionsFrom ? optionsKindOf(f, input) : null;
      if (unitKind && (unitLists ??= await loadUnitLists(em, user.companyId)).get(unitKind)?.some((i) => i.active)) {
        // 公司维护了这一类单位：按名称或编码对应（如“箱”“CTN”），常见写法（公斤、只…）先对到内置单位再找
        let v = unitValueFromText(unitLists, unitKind, raw);
        const common = v === undefined && f.options === UNIT_OPTIONS ? unitOptionFromText(raw) : undefined;
        if (common) v = unitValueFromText(unitLists, unitKind, common.label) ?? unitValueFromText(unitLists, unitKind, common.value);
        if (v === undefined) errors.push(`${f.label}“${raw}”不在“单位与规格”里`);
        else input[f.key] = v;
      } else if (f.type === 'select' && f.key === def.tabsBy && (catOpts ??= await categoryOptionsFor(em, user.companyId, def))) {
        // 页签分类：按本公司的名称或值识别（含自建分类、改名后的名称；也认代码里的原名）
        const hit = categoryFromText(catOpts.options, raw);
        if (hit.value === undefined) errors.push(hit.hiddenHit ? `${f.label}“${raw}”已隐藏，不能再选用` : `${f.label}“${raw}”不在可选项里`);
        else input[f.key] = hit.value;
      } else if (f.type === 'select') {
        const opt = f.options?.find((o) => o.label === raw || o.value === raw) ?? (f.options === UNIT_OPTIONS ? unitOptionFromText(raw) : undefined);
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
          let matches = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: f.ref!, title: raw }, select: ['id'], take: 2 });
          // 存放位置可以填完整路径（如 总部/二楼/保险柜），按上级链逐级核对
          if (matches.length === 0 && f.ref === 'locations' && /[\/>→›]/.test(raw)) matches = await this.locationByPath(em, user.companyId, raw);
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
  async importRows(user: AuthUser, type: string, rows: Array<Record<string, string>>, dryRun: boolean, partial = false, parentId?: number) {
    const def = this.def(type);
    const parentField = parentId ? def.fields.find(f => f.key === def.parent?.field && f.type === 'ref' && f.ref === def.parent?.type) : undefined;
    if (parentId && !parentField) throw new BadRequestException('该资料不支持指定上级导入');
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
          const row = parentField ? Object.fromEntries(Object.entries(rows[i]).filter(([key]) => key !== parentField.key && key !== parentField.label)) : rows[i];
          const converted = await this.rowToInput(em, user, def, row);
          if (parentField) converted.input[parentField.key] = parentId;
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
            if (!existing && !def.uniqueField && def.importMatchChoices?.length) {
              const keys=def.importMatchChoices.find(choice=>choice.every(k=>converted.input[k]!=null && converted.input[k]!==''));
              if(keys){
                const qb=em.createQueryBuilder(ResourceRecord,'r').where('r.companyId = :c AND r.type = :t',{c:user.companyId,t:type});
                keys.forEach((k,i)=>qb.andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${k}')) = :imc${i}`,{[`imc${i}`]:String(converted.input[k])}));
                const matches=await qb.take(2).getMany();
                if(matches.length>1)throw new ConflictException('导入匹配到多条记录，请先处理重复资料');
                existing=matches[0] ?? null;
              }
            }
            if (!existing) existing = await certImportMatch(type, { em, host: this, user, input: converted.input });
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
    if (type.startsWith('finance-cost-')) throw new BadRequestException('成本版本不支持整类导入回滚，请复制草稿版本调整，避免覆盖锁定成本');
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
