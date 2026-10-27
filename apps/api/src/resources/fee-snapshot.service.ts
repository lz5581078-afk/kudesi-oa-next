import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, FeeArchiveSnapshot, ResourceRecord } from '../entities';
import { ResourcesService } from './resources.service';

const CAT = 'finance-fee-categories';
const ITEM = 'finance-fee-items';
type Row = { id: number; type: string; title: string; uniqueKey: string | null; status: string; statusReason: string | null; searchText: string; data: Record<string, unknown>; createdBy: number | null };

/**
 * 费用档案存档表：把当前费用类别 + 费用项目整份存成命名快照；可查看、恢复、删除。
 * 恢复按记录编号还原（单据里引用的费用项目编号不变）；快照里没有的记录不删除，改为停用；恢复前自动再存一份当前状态。
 */
@Injectable()
export class FeeSnapshotService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly resources: ResourcesService) {}

  private need(user: AuthUser, action: 'view' | 'create' | 'delete') {
    const can = createChecker(user.permissions);
    if (!can(`resource.${ITEM}.${action}`)) throw new ForbiddenException('没有这项费用档案权限');
    if (action !== 'view' && !can(`resource.${CAT}.${action === 'delete' ? 'delete' : 'create'}`)) throw new ForbiddenException('没有费用类别权限');
  }

  async list(user: AuthUser) {
    this.need(user, 'view');
    const rows = await this.dataSource.getRepository(FeeArchiveSnapshot).find({ where: { companyId: user.companyId }, order: { id: 'DESC' }, select: ['id', 'name', 'remark', 'auto', 'categoryCount', 'itemCount', 'createdAt', 'restoredAt'] });
    return rows.map((r) => ({ id: r.id, name: r.name, remark: r.remark ?? '', auto: r.auto, categoryCount: r.categoryCount, itemCount: r.itemCount, createdAt: r.createdAt, restoredAt: r.restoredAt }));
  }

  private async capture(em: EntityManager, user: AuthUser, name: string, remark: string | undefined, auto: boolean) {
    const rows = await em.find(ResourceRecord, { where: [{ companyId: user.companyId, type: CAT }, { companyId: user.companyId, type: ITEM }], order: { id: 'ASC' } });
    const snap: Row[] = rows.map((r) => ({ id: r.id, type: r.type, title: r.title, uniqueKey: r.uniqueKey, status: r.status, statusReason: r.statusReason, searchText: r.searchText, data: r.data, createdBy: r.createdBy }));
    return em.save(FeeArchiveSnapshot, em.create(FeeArchiveSnapshot, {
      companyId: user.companyId, name, remark: remark?.trim() || null, auto, createdBy: user.id,
      categoryCount: snap.filter((r) => r.type === CAT).length, itemCount: snap.filter((r) => r.type === ITEM).length, snapshotJson: JSON.stringify(snap),
    }));
  }

  async create(user: AuthUser, name: string, remark?: string) {
    this.need(user, 'create');
    const n = name?.trim();
    if (!n) throw new BadRequestException('请填写存档名称');
    const s = await this.capture(this.dataSource.manager, user, n.slice(0, 120), remark, false);
    return { id: s.id, categoryCount: s.categoryCount, itemCount: s.itemCount };
  }

  async view(user: AuthUser, id: number) {
    this.need(user, 'view');
    const s = await this.dataSource.getRepository(FeeArchiveSnapshot).findOne({ where: { id, companyId: user.companyId } });
    if (!s) throw new NotFoundException('存档不存在');
    const rows = JSON.parse(s.snapshotJson) as Row[];
    const cats = new Map(rows.filter((r) => r.type === CAT).map((r) => [r.id, r]));
    const path = (cid: unknown): string => {
      const out: string[] = [];
      for (let c = cats.get(Number(cid)), i = 0; c && i < 8; i++) { out.unshift(c.title); c = cats.get(Number(c.data.parentId)); }
      return out.join(' / ');
    };
    return {
      id: s.id, name: s.name, remark: s.remark ?? '', createdAt: s.createdAt,
      categories: [...cats.values()].map((c) => path(c.id)).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      items: rows.filter((r) => r.type === ITEM).map((r) => ({ code: String(r.data.code ?? ''), name: r.title, category: path(r.data.categoryId), status: r.status })),
    };
  }

  async restore(user: AuthUser, id: number) {
    this.need(user, 'create');
    const s = await this.dataSource.getRepository(FeeArchiveSnapshot).findOne({ where: { id, companyId: user.companyId } });
    if (!s) throw new NotFoundException('存档不存在');
    const snap = JSON.parse(s.snapshotJson) as Row[];
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16);
    return this.dataSource.transaction(async (em) => {
      await this.capture(em, user, `恢复「${s.name}」前自动备份 ${stamp}`, undefined, true);
      const keep = new Set(snap.map((r) => r.id));
      let restored = 0;
      let stopped = 0;
      // 类别在前、项目在后，引用关系才对得上
      for (const row of [...snap.filter((r) => r.type === CAT), ...snap.filter((r) => r.type === ITEM)]) {
        const fields = { title: row.title, uniqueKey: row.uniqueKey, status: row.status, statusReason: row.statusReason, searchText: row.searchText, data: row.data, updatedBy: user.id };
        const exist = await em.findOne(ResourceRecord, { where: { id: row.id, companyId: user.companyId, type: row.type } });
        if (exist) await em.update(ResourceRecord, { id: row.id }, fields as never);
        else await em.insert(ResourceRecord, { id: row.id, companyId: user.companyId, type: row.type, createdBy: row.createdBy, ...fields } as never);
        restored++;
      }
      for (const row of snap) await this.resources.resyncLinks(em, user, row.type, row.id);
      const now = await em.find(ResourceRecord, { where: [{ companyId: user.companyId, type: CAT }, { companyId: user.companyId, type: ITEM }], select: ['id', 'status'] });
      for (const r of now) {
        if (keep.has(r.id) || r.status === 'inactive') continue;
        await em.update(ResourceRecord, { id: r.id }, { status: 'inactive', statusReason: `恢复存档「${s.name}」时不在存档里`, updatedBy: user.id } as never);
        stopped++;
      }
      await em.update(FeeArchiveSnapshot, { id }, { restoredAt: () => 'NOW()' } as never);
      await em.insert(AuditLog, { companyId: user.companyId, actorId: user.id, action: 'finance.fee-archive.restore', resourceType: 'finance-fee-snapshot', resourceId: String(id), detail: { restored, stopped } } as never);
      return { restored, stopped };
    });
  }

  async remove(user: AuthUser, id: number) {
    this.need(user, 'delete');
    const r = await this.dataSource.getRepository(FeeArchiveSnapshot).delete({ id, companyId: user.companyId });
    if (!r.affected) throw new NotFoundException('存档不存在');
    return { ok: true };
  }
}
