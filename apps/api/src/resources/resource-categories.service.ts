import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  CATEGORY_CUSTOM_MAX, categoryDefaultSort, categoryDeleteBlock, categoryFieldOf, categoryHideBlock, createChecker, generateCategoryValue, getResourceDef, mergeCategoryOptions, permissionOwner,
  resourcePermission, SPECIAL_PERMISSIONS, validateCategoryLabel, type CategoryManageItem, type ResourceDef,
} from '@kudesi/shared';
import { AuditLog, ResourceCategoryOption, ResourceRecord } from '../entities';
import type { AuthUser } from '../common/auth.decorators';
import { categoryPayload, loadCategoryRows } from './category-options';

/**
 * 资料页签“管理分类”：公司级配置的增删改。
 * 同一公司的所有改动在事务里先锁公司行串行执行（排序、重名检查、删除前的在用数量检查互不穿插）；
 * 每个改动写一条审计日志（audit_logs，系统审计页可查）。
 */
@Injectable()
export class ResourceCategoriesService {
  constructor(private readonly ds: DataSource) {}

  private def(user: AuthUser, type: string): ResourceDef {
    const def = getResourceDef(type);
    if (!def) throw new NotFoundException('没有这种资料');
    const can = createChecker(user.permissions);
    if (!can(SPECIAL_PERMISSIONS.resourceCategoriesManage) || !can(resourcePermission(permissionOwner(type), 'view'))) throw new ForbiddenException('没有权限管理这个资料的分类');
    if (!categoryFieldOf(def)) throw new BadRequestException('这个资料没有可管理的分类页签');
    return def;
  }

  /** 前端缓存用：本公司有配置的资料，只含有查看权限的 */
  async options(user: AuthUser) {
    const can = createChecker(user.permissions);
    return categoryPayload(this.ds.manager, user.companyId, (type) => !!getResourceDef(type) && can(resourcePermission(permissionOwner(type), 'view')));
  }

  /** 管理弹窗：全部分类 + 各自在用的记录数（含停用、归档的记录） */
  async list(user: AuthUser, type: string): Promise<{ field: string; items: CategoryManageItem[] }> {
    const def = this.def(user, type);
    const field = categoryFieldOf(def)!;
    const em = this.ds.manager;
    const options = mergeCategoryOptions(field.options ?? [], await loadCategoryRows(em, user.companyId, def));
    const counts = await this.usage(em, user.companyId, def, field.key);
    return { field: field.key, items: options.map((o) => ({ ...o, count: counts.get(o.value) ?? 0 })) };
  }

  private async usage(em: EntityManager, companyId: number, def: ResourceDef, fieldKey: string) {
    const rows = await em.createQueryBuilder(ResourceRecord, 'r')
      .select(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${fieldKey}'))`, 'v').addSelect('COUNT(*)', 'n')
      .where('r.companyId = :companyId AND r.type = :type', { companyId, type: def.key }).groupBy('v').getRawMany<{ v: string | null; n: string }>();
    return new Map(rows.filter((r) => r.v !== null).map((r) => [String(r.v), Number(r.n)]));
  }

  private async tx<T>(user: AuthUser, fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.ds.transaction(async (em) => {
      await em.query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [user.companyId]);
      return fn(em);
    });
  }

  private audit(em: EntityManager, user: AuthUser, action: string, type: string, value: string, detail: Record<string, unknown>) {
    return em.save(AuditLog, em.create(AuditLog, { companyId: user.companyId, actorId: user.id, action: `resource.category.${action}`, resourceType: type, resourceId: value, detail }));
  }

  /** 把代码里的系统分类也落成行（排序基数 10、20…），改名/排序前调用；已有的不动 */
  private async materialize(em: EntityManager, user: AuthUser, def: ResourceDef, fieldKey: string) {
    const field = def.fields.find((f) => f.key === fieldKey)!;
    const have = new Set((await loadCategoryRows(em, user.companyId, def)).map((r) => r.value));
    const missing = (field.options ?? []).map((o, i) => ({ o, i })).filter(({ o }) => !have.has(o.value));
    if (!missing.length) return;
    await em.insert(ResourceCategoryOption, missing.map(({ o, i }) => ({ companyId: user.companyId, resourceType: def.key, fieldKey, value: o.value, label: o.label, sortOrder: categoryDefaultSort(i), hidden: false, custom: false, createdBy: user.id, updatedBy: user.id })));
  }

  private async current(em: EntityManager, user: AuthUser, def: ResourceDef) {
    const field = categoryFieldOf(def)!;
    return mergeCategoryOptions(field.options ?? [], await loadCategoryRows(em, user.companyId, def));
  }

  async create(user: AuthUser, type: string, name: unknown) {
    const def = this.def(user, type);
    const field = categoryFieldOf(def)!;
    return this.tx(user, async (em) => {
      const options = await this.current(em, user, def);
      const err = validateCategoryLabel(name, options.map((o) => o.label));
      if (err) throw new BadRequestException(err);
      if (options.filter((o) => !o.system).length >= CATEGORY_CUSTOM_MAX) throw new BadRequestException(`自建分类最多 ${CATEGORY_CUSTOM_MAX} 个`);
      await this.materialize(em, user, def, field.key);
      const taken = new Set([...options.map((o) => o.value), ...(await em.find(ResourceCategoryOption, { where: { companyId: user.companyId, resourceType: type, fieldKey: field.key }, select: ['value'] })).map((r) => r.value)]);
      const value = generateCategoryValue(taken);
      const max = Math.max(0, ...options.map((o) => o.sortOrder));
      const label = (name as string).trim();
      await em.insert(ResourceCategoryOption, { companyId: user.companyId, resourceType: type, fieldKey: field.key, value, label, sortOrder: max + 10, hidden: false, custom: true, createdBy: user.id, updatedBy: user.id });
      await this.audit(em, user, 'create', type, value, { label });
      return { value };
    });
  }

  async update(user: AuthUser, type: string, value: string, patch: { name?: string; hidden?: boolean }) {
    const def = this.def(user, type);
    const field = categoryFieldOf(def)!;
    if (patch.name === undefined && patch.hidden === undefined) throw new BadRequestException('没有要修改的内容');
    return this.tx(user, async (em) => {
      const options = await this.current(em, user, def);
      const opt = options.find((o) => o.value === value);
      if (!opt) throw new NotFoundException('分类不存在，可能已被删除，请刷新');
      if (patch.hidden !== undefined && patch.hidden !== opt.hidden && patch.hidden) {
        const block = categoryHideBlock(opt);
        if (block) throw new BadRequestException(block);
      }
      if (patch.name !== undefined) {
        const err = validateCategoryLabel(patch.name, options.filter((o) => o.value !== value).map((o) => o.label));
        if (err) throw new BadRequestException(err);
      }
      if (opt.system) await this.materialize(em, user, def, field.key);
      const row = await em.findOne(ResourceCategoryOption, { where: { companyId: user.companyId, resourceType: type, fieldKey: field.key, value } });
      if (!row) throw new NotFoundException('分类不存在，可能已被删除，请刷新');
      const before = { label: row.label, hidden: row.hidden };
      if (patch.name !== undefined) row.label = patch.name.trim();
      if (patch.hidden !== undefined) row.hidden = patch.hidden;
      row.updatedBy = user.id;
      await em.save(ResourceCategoryOption, row);
      if (patch.name !== undefined && before.label !== row.label) await this.audit(em, user, 'rename', type, value, { before: before.label, after: row.label });
      if (patch.hidden !== undefined && before.hidden !== row.hidden) await this.audit(em, user, row.hidden ? 'hide' : 'show', type, value, { label: row.label });
      return { ok: true };
    });
  }

  /** 按给定顺序重排：必须正好包含当前全部分类（有人同时改过就返回 409，让前端刷新重来） */
  async reorder(user: AuthUser, type: string, values: string[]) {
    const def = this.def(user, type);
    const field = categoryFieldOf(def)!;
    return this.tx(user, async (em) => {
      await this.materialize(em, user, def, field.key);
      const rows = await em.find(ResourceCategoryOption, { where: { companyId: user.companyId, resourceType: type, fieldKey: field.key } });
      const same = values.length === rows.length && new Set(values).size === values.length && values.every((v) => rows.some((r) => r.value === v));
      if (!same) throw new ConflictException('分类已经变化，请刷新后再调整顺序');
      const before = mergeCategoryOptions(field.options ?? [], rows.map((r) => ({ value: r.value, label: r.label, sortOrder: r.sortOrder, hidden: r.hidden, custom: r.custom }))).map((o) => o.value);
      for (const [i, v] of values.entries()) {
        const row = rows.find((r) => r.value === v)!;
        const next = (i + 1) * 10;
        if (row.sortOrder !== next) { row.sortOrder = next; row.updatedBy = user.id; await em.save(ResourceCategoryOption, row); }
      }
      if (before.join() !== values.join()) await this.audit(em, user, 'reorder', type, '', { before, after: values });
      return { ok: true };
    });
  }

  async remove(user: AuthUser, type: string, value: string) {
    const def = this.def(user, type);
    const field = categoryFieldOf(def)!;
    return this.tx(user, async (em) => {
      const options = await this.current(em, user, def);
      const opt = options.find((o) => o.value === value);
      if (!opt) throw new NotFoundException('分类不存在，可能已被删除，请刷新');
      // 先锁分类行，再数在用记录：保存记录时对自建分类加共享锁，所以数完之后不会再有人选到它
      const row = await em.createQueryBuilder(ResourceCategoryOption, 'o').setLock('pessimistic_write')
        .where('o.companyId = :c AND o.resourceType = :t AND o.fieldKey = :f AND o.value = :v', { c: user.companyId, t: type, f: field.key, v: value }).getOne();
      const used = (await this.usage(em, user.companyId, def, field.key)).get(value) ?? 0;
      const block = categoryDeleteBlock(opt, used);
      if (block) throw new BadRequestException(block);
      if (!row) throw new NotFoundException('分类不存在，可能已被删除，请刷新');
      await em.delete(ResourceCategoryOption, { id: row.id });
      await this.audit(em, user, 'delete', type, value, { label: opt.label });
      return { ok: true };
    });
  }
}
