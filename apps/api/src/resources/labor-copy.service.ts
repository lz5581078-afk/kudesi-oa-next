import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createChecker, permissionOwner, resourcePermission } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { ResourcesService } from './resources.service';
import { lockLaborCompany, withLaborCopySource } from './labor-rules';

export interface LaborCopyInput { versionCode: string; versionName: string; periodName?: string; effectiveFrom?: string; effectiveTo?: string; remark?: string }

/** 复制人力成本版本（旧系统“复制版本”）：新版本是草稿，带上原版本的归档分类树和全部工作项目（含停用的、单价、零值原因）。 */
@Injectable()
export class LaborCopyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly resources: ResourcesService) {}

  async copyVersion(user: AuthUser, sourceId: number, input: LaborCopyInput) {
    const can = createChecker(user.permissions);
    if (!can(resourcePermission('finance-labor-costs', 'view'))) throw new ForbiddenException('没有查看人力成本版本的权限');
    for (const t of ['finance-labor-versions', 'finance-labor-categories', 'finance-labor-costs']) {
      if (!can(resourcePermission(permissionOwner(t), 'create'))) throw new ForbiddenException('没有新建人力成本版本、分类和项目的权限');
    }
    if (!can('product.cost.view') || !can('product.cost.edit')) throw new ForbiddenException('复制版本会带走全部单价，需要成本查看和修改权限');
    return this.dataSource.transaction(async em => {
      await lockLaborCompany(em, user.companyId);
      const source = await em.findOne(ResourceRecord, { where: { id: sourceId, companyId: user.companyId, type: 'finance-labor-versions' }, lock: { mode: 'pessimistic_write' } });
      if (!source || source.archivedAt) throw new BadRequestException('要复制的版本不存在');
      const v = await this.resources.createRecord(em, user, 'finance-labor-versions', {
        versionCode: input.versionCode, versionName: input.versionName, periodName: input.periodName || undefined,
        effectiveFrom: input.effectiveFrom || undefined, effectiveTo: input.effectiveTo || undefined, note: input.remark || undefined,
      }, '复制人力成本版本');
      const own = (await this.resources.findWhere(em, user.companyId, 'finance-labor-categories', 'versionId', source.id)).filter(row => !row.archivedAt);
      const map = new Map<number, number>();
      let pending = own;
      while (pending.length) {
        const next: ResourceRecord[] = [];
        for (const c of pending) {
          const p = typeof c.data.parentId === 'number' ? c.data.parentId : null;
          if (p !== null && !map.has(p)) { next.push(c); continue; }
          const n = await this.resources.createRecord(em, user, 'finance-labor-categories', {
            versionId: v.id, parentId: p === null ? undefined : map.get(p), name: c.data.name, code: c.data.code, sortOrder: c.data.sortOrder,
          });
          map.set(c.id, n.id);
        }
        if (next.length === pending.length) throw new BadRequestException('原版本的分类层级有问题，无法复制');
        pending = next;
      }
      const items = (await this.resources.findWhere(em, user.companyId, 'finance-labor-costs', 'versionId', source.id)).filter(row => !row.archivedAt).sort((a, b) => a.id - b.id);
      for (const i of items) {
        await withLaborCopySource(i, () => this.resources.createRecord(em, user, 'finance-labor-costs', {
          versionId: v.id, archiveCategoryId: map.get(Number(i.data.archiveCategoryId)), workTypeId: i.data.workTypeId, workName: i.data.workName,
          unitId: i.data.unitId, unitPrice: i.data.unitPrice, zeroReason: i.data.zeroReason, note: i.data.note ?? i.data.remark,
        }, '复制版本工作项目', i.status));
      }
      return { id: v.id, categories: map.size, items: items.length };
    });
  }
}
