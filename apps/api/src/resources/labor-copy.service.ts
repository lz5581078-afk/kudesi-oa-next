import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { ResourcesService } from './resources.service';

export interface LaborCopyInput { versionCode: string; versionName: string; periodName?: string; effectiveFrom?: string; effectiveTo?: string; remark?: string }

/** 复制人力成本版本（旧系统“复制版本”）：新版本是草稿，带上原版本的归档分类树和全部工作项目（含停用的、单价、零值原因）。 */
@Injectable()
export class LaborCopyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly resources: ResourcesService) {}

  async copyVersion(user: AuthUser, sourceId: number, input: LaborCopyInput) {
    const can = createChecker(user.permissions);
    for (const t of ['finance-labor-versions', 'finance-labor-categories', 'finance-labor-costs']) {
      if (!can(`resource.${t}.create`)) throw new ForbiddenException('没有新建人力成本版本、分类和项目的权限');
    }
    if (!can('product.cost.view') || !can('product.cost.edit')) throw new ForbiddenException('复制版本会带走全部单价，需要成本查看和修改权限');
    const em = this.dataSource.manager;
    const source = await em.findOne(ResourceRecord, { where: { id: sourceId, companyId: user.companyId, type: 'finance-labor-versions' } });
    if (!source) throw new BadRequestException('要复制的版本不存在');
    const created: number[] = [];
    try {
      const v = await this.resources.create(user, 'finance-labor-versions', {
        versionCode: input.versionCode, versionName: input.versionName, periodName: input.periodName || undefined,
        effectiveFrom: input.effectiveFrom || undefined, effectiveTo: input.effectiveTo || undefined, remark: input.remark || undefined,
      }, 'draft');
      created.push(v.id);
      const cats = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-labor-categories' } });
      const own = cats.filter((c) => c.data.versionId === source.id);
      const map = new Map<number, number>();
      let pending = own;
      while (pending.length) {
        const next: ResourceRecord[] = [];
        for (const c of pending) {
          const p = typeof c.data.parentId === 'number' ? c.data.parentId : null;
          if (p !== null && !map.has(p)) { next.push(c); continue; }
          const n = await this.resources.create(user, 'finance-labor-categories', {
            versionId: v.id, parentId: p === null ? undefined : map.get(p), name: c.data.name, code: c.data.code, sortOrder: c.data.sortOrder,
          });
          created.push(n.id);
          map.set(c.id, n.id);
        }
        if (next.length === pending.length) throw new BadRequestException('原版本的分类层级有问题，无法复制');
        pending = next;
      }
      const items = (await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-labor-costs' }, order: { id: 'ASC' } })).filter((i) => i.data.versionId === source.id);
      for (const i of items) {
        const n = await this.resources.create(user, 'finance-labor-costs', {
          versionId: v.id, archiveCategoryId: map.get(Number(i.data.archiveCategoryId)), workTypeId: i.data.workTypeId, workName: i.data.workName,
          unitId: i.data.unitId, unitPrice: i.data.unitPrice, zeroReason: i.data.zeroReason, remark: i.data.remark,
        }, i.status);
        created.push(n.id);
      }
      return { id: v.id, categories: map.size, items: items.length };
    } catch (e) {
      if (created.length) await em.delete(ResourceRecord, { companyId: user.companyId, id: In(created) }); // 复制中途失败：把已建的清掉
      throw e;
    }
  }
}
