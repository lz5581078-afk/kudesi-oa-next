import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { percentToMicro } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceChangeLog, ResourceRecord } from '../entities';
import { bundleRevision, COST_TABLE_STATUSES, marginRevision } from './cost.service';
import { DataToolsService } from './data-tools.service';
import { ResourcesService } from './resources.service';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const MARGIN_MESSAGE = '利润率必须在 0% 到 100% 之间（不含 100%），最多保留 6 位小数';
const STALE_MESSAGE = '成本资料已变化，请刷新后重新核对';
export const PRICING_NOTE = '维护售价：';

export interface PricingInput { revision: string; carrierName: string; profitPercent: number | null; reason: string }
export interface CategoryMarginInput { revision: string; profitPercent: number | null; reason: string }

function cleanReason(reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r || r.length > 300) throw new BadRequestException('请填写修改原因（最多 300 字）');
  return r;
}

function cleanPercent(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || percentToMicro(value) === null) throw new BadRequestException(MARGIN_MESSAGE);
  return value;
}

/**
 * 成本表上的“维护售价”：每个组合的使用快递、单品利润率，以及分类/全部默认利润率。
 * 都落在原来的资料上（组合编码、利润率设置），不另存一份；两个人同时改时，
 * 后保存的那个会收到“已变化”提示，不会悄悄覆盖。
 */
@Injectable()
export class CostMaintainService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly resources: ResourcesService,
    private readonly tools: DataToolsService,
  ) {}

  async savePricing(user: AuthUser, bundleId: number, input: PricingInput) {
    const reason = cleanReason(input.reason);
    const carrier = (typeof input.carrierName === 'string' ? input.carrierName : '').trim();
    if (carrier.length > 80) throw new BadRequestException('快递名称最多 80 字');
    const percent = cleanPercent(input.profitPercent);
    let changed = false;
    await this.dataSource.transaction(async (em) => {
      const b = await em.findOne(ResourceRecord, { where: { id: bundleId, companyId: user.companyId, type: 'finance-bundles' }, lock: { mode: 'pessimistic_write' } });
      if (!b) throw new NotFoundException('组合不存在');
      if (!COST_TABLE_STATUSES.includes(b.status)) throw new ConflictException('成本表只维护已验证的组合；这个组合还没验证或已失效归档');
      if (input.revision !== bundleRevision(b)) throw new ConflictException(STALE_MESSAGE);
      const sameCarrier = String(b.data.carrierName ?? '') === carrier;
      const samePercent = (num(b.data.marginOverridePercent) ?? null) === percent;
      if (sameCarrier && samePercent) return;
      const notes: string[] = [];
      if (!sameCarrier) notes.push(`使用快递「${String(b.data.carrierName ?? '') || '未指定'}」→「${carrier || '未指定'}」`);
      if (!samePercent) notes.push(`单品利润率 ${num(b.data.marginOverridePercent) ?? '继承'} → ${percent ?? '继承'}`);
      await this.resources.patchData(em, user, 'finance-bundles', bundleId, { carrierName: carrier || null, marginOverridePercent: percent, overrideReason: reason }, `${PRICING_NOTE}${reason}（${notes.join('；')}）`.slice(0, 500));
      changed = true;
      // 成本历史：新的最低售价和上一版不同，就登记一版（和保存在同一个事务里）
      await this.tools.registerCost(user, bundleId, reason, em, 'pricing_update');
    });
    return { ok: true, changed };
  }

  /** categoryId = 0 表示“全部默认” */
  async saveCategoryMargin(user: AuthUser, categoryId: number, input: CategoryMarginInput) {
    const reason = cleanReason(input.reason);
    const percent = cleanPercent(input.profitPercent);
    let changed = false;
    await this.dataSource.transaction(async (em) => {
      if (categoryId > 0) {
        const cat = await em.findOne(ResourceRecord, { where: { id: categoryId, companyId: user.companyId, type: 'finance-categories' } });
        if (!cat || cat.status !== 'active') throw new NotFoundException('分类不存在或已停用');
        if (cat.data.archiveType !== 'bundle') throw new BadRequestException('分类利润率只能设在组合分类上');
      }
      const scopeKey = categoryId > 0 ? `cat:${categoryId}` : 'all';
      const existing = await em.findOne(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-margins', uniqueKey: scopeKey }, lock: { mode: 'pessimistic_write' } });
      if (input.revision !== marginRevision(existing ?? undefined)) throw new ConflictException('分类利润率已被别人更新，请刷新后重试');
      if (existing) {
        if ((num(existing.data.profitPercent) ?? null) === percent) return;
        await this.resources.patchData(em, user, 'finance-margins', existing.id, { profitPercent: percent, reason }, `维护分类利润率：${reason}`.slice(0, 500));
      } else {
        if (percent === null) return;
        await this.resources.createRecord(em, user, 'finance-margins', { ...(categoryId > 0 ? { categoryId } : {}), profitPercent: percent, reason }, `维护分类利润率：${reason}`.slice(0, 500));
      }
      changed = true;
    });
    return { ok: true, changed };
  }

  /** 分类利润率调整记录（谁、什么时候、从多少改成多少、为什么） */
  async marginHistory(user: AuthUser, q: { keyword?: string; page: number; pageSize: number }) {
    const where = ['l.company_id = ?', "l.resource_type = 'finance-margins'"];
    const args: unknown[] = [user.companyId];
    const kw = q.keyword?.trim();
    if (kw) { where.push('(r.title LIKE ? OR l.note LIKE ?)'); args.push(`%${kw}%`, `%${kw}%`); }
    const from = `FROM resource_change_logs l LEFT JOIN resource_records r ON r.id = l.resource_id AND r.company_id = l.company_id LEFT JOIN users u ON u.id = l.actor_id AND u.company_id = l.company_id WHERE ${where.join(' AND ')}`;
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n ${from}`, args);
    const rows = await this.dataSource.query(
      `SELECT l.id, l.action, l.before_json AS beforeJson, l.after_json AS afterJson, l.note, l.created_at AS createdAt, r.title AS title, u.name AS actorName
       ${from} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize,
      rows: (rows as Array<Record<string, unknown>>).map((r) => {
        const before = json(r.beforeJson), after = json(r.afterJson);
        return {
          id: String(r.id), createdAt: r.createdAt, actorName: (r.actorName as string | null) ?? '系统', scopeName: String(r.title ?? '').replace(/ 利润率$/, '').replace(/^全部默认利润率$/, '全部默认'),
          beforePercent: num(before?.profitPercent), afterPercent: num(after?.profitPercent), reason: String(after?.reason ?? '') || String(r.note ?? ''),
        };
      }),
    };
  }

  /** 组合售价维护记录（使用快递、单品利润率的修改） */
  async pricingHistory(user: AuthUser, q: { bundleId?: number; keyword?: string; page: number; pageSize: number }) {
    const where = ['l.company_id = ?', "l.resource_type = 'finance-bundles'", 'l.note LIKE ?'];
    const args: unknown[] = [user.companyId, `${PRICING_NOTE}%`];
    if (q.bundleId) { where.push('l.resource_id = ?'); args.push(q.bundleId); }
    const kw = q.keyword?.trim();
    if (kw) { where.push('(r.title LIKE ? OR l.note LIKE ?)'); args.push(`%${kw}%`, `%${kw}%`); }
    const from = `FROM resource_change_logs l LEFT JOIN resource_records r ON r.id = l.resource_id AND r.company_id = l.company_id LEFT JOIN users u ON u.id = l.actor_id AND u.company_id = l.company_id WHERE ${where.join(' AND ')}`;
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n ${from}`, args);
    const rows = await this.dataSource.query(
      `SELECT l.id, l.note, l.before_json AS beforeJson, l.after_json AS afterJson, l.created_at AS createdAt, l.resource_id AS bundleId, r.title AS code, r.data->>'$.name' AS name, u.name AS actorName
       ${from} ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize,
      rows: (rows as Array<Record<string, unknown>>).map((r) => {
        const before = json(r.beforeJson), after = json(r.afterJson);
        return {
          id: String(r.id), createdAt: r.createdAt, actorName: (r.actorName as string | null) ?? '系统', bundleId: Number(r.bundleId), code: String(r.code ?? ''), name: String(r.name ?? ''),
          beforeCarrier: String(before?.carrierName ?? ''), afterCarrier: String(after?.carrierName ?? ''),
          beforePercent: num(before?.marginOverridePercent), afterPercent: num(after?.marginOverridePercent),
          reason: String(after?.overrideReason ?? '') || String(r.note ?? '').slice(PRICING_NOTE.length),
        };
      }),
    };
  }
}
