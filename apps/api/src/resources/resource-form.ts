import { createHash } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { createChecker, getResourceDef, permissionOwner, resourcePermission, validateStatusChange, type ResourceDef, type ResourceFormInput } from '@kudesi/shared';
import { DataSource, EntityManager } from 'typeorm';
import { ResourceFormMutation, ResourceRecord } from '../entities';
import { AuthUser } from '../common/auth.decorators';

interface FormHost {
  version(record: ResourceRecord): string;
  save(em: EntityManager, def: ResourceDef, existing: ResourceRecord | null, values: Record<string, unknown>, options: { status?: string; reason?: string; cleanup: string[]; note: string }): Promise<ResourceRecord>;
  remove(em: EntityManager, type: string, id: number, reason: string, cleanup: string[]): Promise<unknown>;
}

/** 配置驱动的整组保存；所有字段规则、引用、审计和下游重算仍走统一资料保存。 */
export async function saveResourceForm(ds: DataSource, user: AuthUser, def: ResourceDef, input: ResourceFormInput, host: FormHost, cleanup: string[]): Promise<number> {
  const can = createChecker(user.permissions);
  const requireAction = (type: string, action: 'create' | 'edit' | 'delete' | 'view' | 'disable') => {
    if (!can(resourcePermission(permissionOwner(type), action))) throw new ForbiddenException(`没有${getResourceDef(type)?.label ?? type}的${({ create: '新增', edit: '编辑', delete: '删除', view: '查看', disable: '修改状态' })[action]}权限`);
  };
  requireAction(def.key, input.id ? 'edit' : 'create');
  if (!def.formChildren?.length || !/^[a-f0-9-]{36}$/i.test(input.requestKey)) throw new BadRequestException('整组保存配置或请求标识不合法');
  if (!Array.isArray(input.collections) || input.collections.length > 8 || new Set(input.collections.map(c => c.type)).size !== input.collections.length) throw new BadRequestException('子表参数不合法');
  for (const collection of input.collections) {
    const child = getResourceDef(collection.type);
    if (!def.formChildren.some(rule => rule.type === collection.type) || !child || child.readOnly || child.parent?.type !== def.key || !child.fields.some(f => f.key === child.parent?.field && f.type === 'ref' && f.ref === def.key)) throw new BadRequestException('这份子表不允许随主档保存');
    requireAction(child.key, 'view');
    if (!Array.isArray(collection.rows) || !Array.isArray(collection.expected) || collection.rows.length > 2000 || collection.expected.length > 2000) throw new BadRequestException('子表行数不合法');
    if (new Set(collection.expected.map(r => r.id)).size !== collection.expected.length || new Set(collection.rows.filter(r => r.id).map(r => r.id)).size !== collection.rows.filter(r => r.id).length) throw new BadRequestException('子表有重复行');
  }
  const hash = createHash('sha256').update(JSON.stringify([def.key, input])).digest('hex');
  const lookup = () => ds.manager.findOneBy(ResourceFormMutation, { companyId: user.companyId, requestKey: input.requestKey });
  const replay = (old: ResourceFormMutation) => {
    if (old.actorId !== user.id || old.resourceType !== def.key || old.requestHash !== hash || !old.recordId) throw new ConflictException('这次保存已经处理，请刷新列表核对结果后再编辑');
    return old.recordId;
  };
  const old = await lookup();
  if (old) return replay(old);
  try {
    return await ds.transaction(async em => {
      // 唯一键让同一请求的并发重试等待事务结果，不重复创建主档或子行。
      const attempt = await em.save(ResourceFormMutation, em.create(ResourceFormMutation, { companyId: user.companyId, actorId: user.id, resourceType: def.key, requestKey: input.requestKey, requestHash: hash, recordId: null }));
      const existing = input.id ? await em.findOne(ResourceRecord, { where: { id: input.id, companyId: user.companyId, type: def.key }, lock: { mode: 'pessimistic_write' } }) : null;
      if (input.id && !existing) throw new NotFoundException('主档不存在');
      if (existing?.archivedAt) throw new ConflictException('主档已归档，请刷新后重试');
      if (existing && (!input.version || host.version(existing) !== input.version)) throw new ConflictException('主档刚被修改，请刷新后重试');
      const prepared = [];
      for (const collection of input.collections) {
        const child = getResourceDef(collection.type)!;
        const minimum = def.formChildren!.find(rule => rule.type === child.key)?.minRowsBy;
        const values = { ...(existing?.data ?? {}), ...input.values };
        const minRows = minimum?.map[String(values[minimum.field] ?? '')] ?? 0;
        if (collection.rows.length < minRows) throw new BadRequestException(`${child.label}至少保留${minRows}条完整资料`);
        const field = child.parent!.field;
        const current = existing ? await em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :company AND r.type = :type AND r.archivedAt IS NULL', { company: user.companyId, type: child.key }).andWhere('JSON_EXTRACT(r.data, :path) = :parent', { path: `$.${field}`, parent: existing.id }).orderBy('r.id', 'ASC').setLock('pessimistic_write').getMany() : [];
        const byId = new Map(current.map(row => [row.id, row]));
        if (current.length !== collection.expected.length || collection.expected.some(row => !byId.has(row.id) || !row.version || host.version(byId.get(row.id)!) !== row.version)) throw new ConflictException(`${child.label}刚被修改，请刷新后重试`);
        if (collection.rows.some(row => row.id !== undefined && !byId.has(row.id))) throw new BadRequestException('子表行不属于当前主档');
        const rows = collection.rows.map(row => {
          if (row.values[field] !== undefined && row.values[field] !== existing?.id) throw new BadRequestException('不能更改子表归属');
          const before = row.id ? byId.get(row.id)! : null;
          const changed = !before || Object.entries(row.values).some(([key, value]) => JSON.stringify(before.data[key] ?? null) !== JSON.stringify(value ?? null));
          if (changed) requireAction(child.key, before ? 'edit' : 'create');
          return { ...row, before, changed };
        });
        const keep = new Set(rows.map(row => row.id));
        const removed = current.filter(row => !keep.has(row.id));
        if (removed.length) requireAction(child.key, 'delete');
        prepared.push({ child, field, rows, removed });
      }
      const changingStatus = existing && input.status && input.status !== existing.status;
      if (changingStatus) {
        requireAction(def.key, 'disable');
        const problem = validateStatusChange(def, input.status!, input.statusReason);
        if (problem) throw new BadRequestException(problem);
      }
      const parent = await host.save(em, def, existing, input.values, { status: input.status, reason: input.statusReason, cleanup, note: '整组保存资料' });
      if (changingStatus) { parent.statusReason = input.statusReason?.trim() || null; await em.save(ResourceRecord, parent); }
      for (const { child, field, rows, removed } of prepared) {
        for (const [index, row] of rows.entries()) if (row.changed) {
          try { await host.save(em, child, row.before, { ...row.values, [field]: parent.id }, { cleanup, note: '随主档整组保存' }); }
          catch (error) {
            if (!(error instanceof HttpException)) throw error;
            throw new HttpException(`${child.label}第${index + 1}行：${error.message}`, error.getStatus());
          }
        }
        for (const row of removed) await host.remove(em, child.key, row.id, '在主档表单中移除', cleanup);
      }
      await em.update(ResourceFormMutation, { id: attempt.id }, { recordId: parent.id });
      return parent.id;
    });
  } catch (error) {
    // 并发相同请求的唯一键冲突：只复用相同公司、操作者及完整请求的已提交结果。
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') { const committed = await lookup(); if (committed) return replay(committed); }
    throw error;
  }
}
