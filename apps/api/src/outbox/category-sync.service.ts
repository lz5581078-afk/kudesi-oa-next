import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { buildPlan, hash, LinkRow, localTree, PlanError, RemoteNode } from './category-plan';
import { JST_CHANNEL, OutboxService } from './outbox.service';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const parse = <T>(v: unknown): T | null => (v == null ? null : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
export type CategoryScope = 'product' | 'bundle';

/**
 * 聚水潭商品分类同步（旧系统 category-sync-*）：OA 分类单向同步到聚水潭。
 * 流程：预览差异（只读聚水潭）→ 人工确认（带差异指纹）→ 按差异入出站队列，由唯一的 worker 发送并回读确认。
 * 只有公司管理员能操作；总开关关着时只入队不发送；没有自动同步（需要另行授权）。
 */
@Injectable()
export class CategorySyncService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly outbox: OutboxService) {}

  private admin(user: AuthUser) { if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能同步聚水潭分类'); }

  private async snapshot(user: AuthUser, scope: CategoryScope) {
    const sender = await this.outbox.senderFor(user.companyId);
    const readRemote = sender.readCategories ? () => sender.readCategories!() : null;
    const targetKey = sender.targetKey;
    if (!readRemote || !targetKey) throw new ConflictException('还没有接入聚水潭（或没有配置企业编号），无法读取聚水潭分类，也就不能核对差异');
    const all = await this.ds.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-categories' } });
    const inScope = all.filter((c) => (c.data.archiveType === 'bundle') === (scope === 'bundle'));
    let local;
    try { local = localTree(inScope.map((c) => ({ id: c.id, name: str(c.data.name), parentId: num(c.data.parentId), sort: num(c.data.sort) ?? 0, enable: c.status === 'active' }))); }
    catch (e) { if (e instanceof PlanError) throw new ConflictException(e.message); throw e; }
    const raw: Array<{ category_id: number; remote_id: string | null; status: string; local_json: unknown; remote_json: unknown; pending_json: unknown }> = await this.ds.query(
      'SELECT category_id, remote_id, status, local_json, remote_json, pending_json FROM jst_category_links WHERE company_id = ? AND target_key = ? ORDER BY category_id', [user.companyId, targetKey]);
    const mine = new Set(inScope.map((c) => c.id));
    const known = new Set(all.map((c) => c.id));
    // 已删除的分类（本地没有了）也要看，用来停用/收尾；另一个类型的分类不算
    const links: LinkRow[] = raw.filter((l) => mine.has(l.category_id) || !known.has(l.category_id)).map((l) => ({ localId: String(l.category_id), remoteId: l.remote_id, status: l.status, local: parse(l.local_json), remote: parse(l.remote_json), pending: parse(l.pending_json) }));
    const allLinks = raw.map((l) => ({ localId: String(l.category_id), remoteId: l.remote_id }));
    let remote: RemoteNode[];
    try { remote = (await readRemote()).map((r) => ({ id: String(r.id), name: r.name, parentId: String(r.parentId || 0), sort: r.sort, enable: r.enable })); }
    catch (e) { throw new ConflictException(`读取聚水潭分类失败：${(e as Error).message}`); }
    // 关联表里存的 local_json 要带 depth/path（删除分类时用来显示）
    const plan = buildPlan({ local, remote, links, allLinks, targetKey });
    return { plan: { ...plan, signature: hash([plan.signature, local.map((n) => n.name)]) }, targetKey, links };
  }

  async preview(user: AuthUser, scope: CategoryScope) {
    this.admin(user);
    const { plan, targetKey } = await this.snapshot(user, scope);
    return {
      scope, targetKey, signature: plan.signature, conflicts: plan.conflicts, remoteOnly: plan.remoteOnly.length,
      changes: plan.changes.map((c) => ({ localId: c.localId, path: c.path, action: c.action, message: c.message, before: c.before, after: c.after })),
      note: '聚水潭未返回排序或启用状态时，这两项按 OA 配置写入，不能判断远端是否单独修改过。删除同步为停用。',
    };
  }

  /** 确认执行：差异必须和预览时一致；有冲突不执行；只入队，不发送 */
  async execute(user: AuthUser, scope: CategoryScope, signature: string, confirmed: boolean) {
    this.admin(user);
    if (confirmed !== true) throw new ConflictException('请先确认差异，再执行同步');
    const { plan, targetKey } = await this.snapshot(user, scope);
    if (signature !== plan.signature) throw new ConflictException('两端资料已变化，请刷新差异后重新确认');
    if (plan.conflicts) throw new ConflictException(`存在 ${plan.conflicts} 项分类冲突，请先到预览里处理`);
    const em = this.ds.manager;
    const details: Array<{ localId: string; path: string; action: string; jobId: number | null; status: string }> = [];
    let queued = 0;
    const nodeById = new Map(plan.nodes.map((n) => [n.id, n]));
    for (const op of plan.changes) {
      if (op.action === 'retire') {
        const [lk] = await em.query('SELECT local_json FROM jst_category_links WHERE company_id = ? AND target_key = ? AND category_id = ?', [user.companyId, targetKey, Number(op.localId)]);
        const retired = { ...(parse<Record<string, unknown>>(lk?.local_json) ?? {}), enable: false };
        await em.query("UPDATE jst_category_links SET local_json = ?, remote_json = NULL, pending_json = NULL, status = 'retired' WHERE company_id = ? AND target_key = ? AND category_id = ?", [JSON.stringify(retired), user.companyId, targetKey, Number(op.localId)]);
        details.push({ localId: op.localId, path: op.path, action: op.action, jobId: null, status: 'success' });
        continue;
      }
      const after = op.after as { name: string; parentId: string; sort: number | null; enable: boolean };
      const node = nodeById.get(op.localId) ?? { ...(parse<Record<string, unknown>>((await em.query('SELECT local_json FROM jst_category_links WHERE company_id = ? AND target_key = ? AND category_id = ?', [user.companyId, targetKey, Number(op.localId)]))[0]?.local_json) ?? {}), enable: false };
      const desired: Record<string, unknown> = { name: after.name, sort: after.sort ?? 0, enable: after.enable };
      if (after.parentId.startsWith('local:')) desired.parentLocalId = after.parentId.slice(6); else desired.parentRemoteId = after.parentId;
      const remoteId = (op.before as RemoteNode | null)?.id ?? null;
      const payload = { op: op.action, localId: op.localId, remoteId, desired, local: node, targetKey, sku_id: `category:${op.localId}` };
      const baseKey = `cat:${op.localId}:${hash({ remoteId, desired }).slice(0, 16)}`;
      const prior: { idempotency_key: string; status: string }[] = await em.query("SELECT idempotency_key, status FROM outbox_jobs WHERE company_id = ? AND kind = 'category_sync' AND resource_id = ? AND (idempotency_key = ? OR idempotency_key LIKE ?)", [user.companyId, Number(op.localId), baseKey, `${baseKey}:%`]);
      const live = prior.find((p) => ['pending', 'sending'].includes(p.status));
      if (live) { details.push({ localId: op.localId, path: op.path, action: op.action, jobId: null, status: 'queued' }); continue; }
      const key = prior.length ? `${baseKey}:${prior.length}` : baseKey;
      const res = await em.query('INSERT IGNORE INTO outbox_jobs (company_id, channel, kind, resource_type, resource_id, idempotency_key, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [user.companyId, JST_CHANNEL, 'category_sync', 'finance-categories', Number(op.localId), key, JSON.stringify(payload), user.id]);
      if (res.affectedRows) queued++;
      details.push({ localId: op.localId, path: op.path, action: op.action, jobId: Number(res.insertId) || null, status: 'queued' });
    }
    const run = await em.query('INSERT INTO jst_category_runs (company_id, mode, actor_id, status, message, details_json) VALUES (?, ?, ?, ?, ?, ?)',
      [user.companyId, scope, user.id, 'queued', `已加入同步队列 ${queued} 项（${scope === 'bundle' ? '组合分类' : '商品分类'}）`, JSON.stringify({ signature: plan.signature, targetKey, changes: details })]);
    return { runId: Number(run.insertId), queued, retired: details.filter((d) => d.action === 'retire').length };
  }

  /** 同步记录：状态跟着队列里任务的实际结果走 */
  async runs(user: AuthUser, page: number) {
    this.admin(user);
    const rows: Array<{ id: number; mode: string; actor_id: number | null; status: string; message: string; details_json: unknown; created_at: string }> = await this.ds.query(
      'SELECT id, mode, actor_id, status, message, details_json, created_at FROM jst_category_runs WHERE company_id = ? ORDER BY id DESC LIMIT 20 OFFSET ?', [user.companyId, (page - 1) * 20]);
    const out = [];
    for (const r of rows) {
      const d = parse<{ changes: Array<{ localId: string; path: string; action: string; jobId: number | null; status: string }> }>(r.details_json) ?? { changes: [] };
      const ids = d.changes.map((c) => c.jobId).filter((x): x is number => !!x);
      const jobs: Array<{ id: number; status: string; last_error: string | null }> = ids.length ? await this.ds.query('SELECT id, status, last_error FROM outbox_jobs WHERE company_id = ? AND id IN (?)', [user.companyId, ids]) : [];
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const changes = d.changes.map((c) => ({ ...c, status: c.jobId ? (byId.get(c.jobId)?.status ?? c.status) : c.status, error: c.jobId ? (byId.get(c.jobId)?.last_error ?? null) : null }));
      const st = changes.some((c) => c.status === 'failed') ? 'failed' : changes.every((c) => ['done', 'success'].includes(c.status)) ? 'success' : changes.some((c) => c.status === 'sending') ? 'running' : 'queued';
      out.push({ id: r.id, scope: r.mode, status: st, message: r.message, createdAt: r.created_at, changes });
    }
    return { page, rows: out };
  }
}
