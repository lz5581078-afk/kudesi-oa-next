import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { OutboxJob } from '../entities';
import { ResourcesService } from '../resources/resources.service';

/**
 * 出站任务发送后的“收尾”：不同种类的任务把结果写回各自的地方。
 *  - bundle_price_update：组合基本售价同步结果 → 组合的 jstPriceStatus/jstPriceCents + 售价日志
 *  - bundle_disable：归档任务（bundle_archive_jobs）的禁用结果
 *  - category_sync：聚水潭分类关联（jst_category_links）
 */
export interface JobCtx { ds: DataSource; resources: ResourcesService; sys: AuthUser }
export interface JobOutcome { remoteId?: string }

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function priceLog(ds: DataSource, job: OutboxJob, status: string, message: string, extra: Record<string, unknown> = {}) {
  const p = job.payloadJson;
  await ds.query('INSERT INTO bundle_price_logs (company_id, bundle_id, status, price_cents, message, outbox_job_id, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [job.companyId, job.resourceId, status, num(p.priceCents), message.slice(0, 800), job.id, JSON.stringify({ sku: str(p.sku_id), ...extra })]);
}

/** 发送并回读确认成功之后 */
export async function afterJobDone(ctx: JobCtx, job: OutboxJob, result?: JobOutcome): Promise<boolean> {
  const { ds, resources, sys } = ctx;
  const p = job.payloadJson;
  if (job.kind === 'bundle_price_update') {
    await ds.transaction((tx) => resources.patchData(tx, sys, 'finance-bundles', job.resourceId, { jstPriceStatus: 'success', jstPriceCents: num(p.priceCents) }, '基本售价已同步到聚水潭'));
    await priceLog(ds, job, 'success', '基本售价已更新并回查确认');
    return true;
  }
  if (job.kind === 'category_sync') {
    const op = str(p.op);
    const local = p.local ?? {};
    const [lk] = await ds.query('SELECT pending_json FROM jst_category_links WHERE company_id = ? AND category_id = ? AND target_key = ?', [job.companyId, job.resourceId, str(p.targetKey) || 'default']);
    const sentDesired = lk?.pending_json ? (typeof lk.pending_json === 'string' ? JSON.parse(lk.pending_json) : lk.pending_json) : null;
    const remoteId = result?.remoteId ?? (str(p.remoteId) || null);
    await ds.query(
      `INSERT INTO jst_category_links (company_id, category_id, target_key, remote_id, status, local_json, remote_json, pending_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON DUPLICATE KEY UPDATE remote_id = VALUES(remote_id), status = VALUES(status), local_json = VALUES(local_json), remote_json = VALUES(remote_json), pending_json = NULL`,
      [job.companyId, job.resourceId, str(p.targetKey) || 'default', remoteId, op === 'retire' ? 'retired' : 'linked', JSON.stringify(local), JSON.stringify(sentDesired && remoteId ? { ...sentDesired, id: remoteId } : null)]);
    return true;
  }
  if (job.kind === 'bundle_disable') {
    await ds.query("UPDATE bundle_archive_jobs SET status = 'success', message = ? WHERE company_id = ? AND bundle_id = ?", ['OA 已归档，聚水潭组合装已回查确认禁用', job.companyId, job.resourceId]);
  }
  return false;
}

/** 发送失败之后。unknown = 已经发出去但回读确认失败/对不上（结果未知，不会自动重发）；dead = 不再自动重试 */
export async function afterJobFailed(ctx: JobCtx, job: OutboxJob, error: string, unknown: boolean, dead: boolean): Promise<boolean> {
  const { ds, resources, sys } = ctx;
  const p = job.payloadJson;
  if (job.kind === 'bundle_price_update') {
    if (!dead) return true;
    const status = unknown ? 'confirming' : 'failed';
    await ds.transaction((tx) => resources.patchData(tx, sys, 'finance-bundles', job.resourceId, { jstPriceStatus: status }, unknown ? '基本售价写入结果待确认' : '基本售价同步失败'));
    await priceLog(ds, job, status, unknown ? `结果未知，请先到聚水潭确认再决定是否重传：${error}` : error);
    return true;
  }
  if (job.kind === 'category_sync') {
    if (dead) {
      // 新增请求发出后结果不明，不能盲目重发；改名/停用被明确拒绝的，修好后可以重新核对再同步
      const status = unknown || str(p.op) === 'create' || str(p.op) === 'bind' ? 'uncertain' : 'rejected';
      await ds.query("UPDATE jst_category_links SET status = ?, pending_json = IF(? = 'rejected', NULL, pending_json) WHERE company_id = ? AND category_id = ? AND target_key = ?", [status, status, job.companyId, job.resourceId, str(p.targetKey) || 'default']);
    }
    return true;
  }
  if (job.kind === 'bundle_disable' && dead) {
    await ds.query("UPDATE bundle_archive_jobs SET status = 'failed', message = ? WHERE company_id = ? AND bundle_id = ?",
      [(unknown ? `禁用结果未确认，请点“复查”核对聚水潭：${error}` : `聚水潭禁用失败：${error}`).slice(0, 800), job.companyId, job.resourceId]);
  }
  return false;
}

/** 发送出去之后（回读确认之前） */
export async function afterJobSent(ctx: JobCtx, job: OutboxJob): Promise<void> {
  if (job.kind === 'bundle_disable') await ctx.ds.query("UPDATE bundle_archive_jobs SET status = 'confirming', message = '已提交聚水潭禁用，等待回查确认' WHERE company_id = ? AND bundle_id = ? AND status IN ('pending', 'failed')", [job.companyId, job.resourceId]);
}

/**
 * 发送之前：分类同步先把“要写什么”记在关联表里（结果不明时留作凭据），并把上级的聚水潭分类 ID 补进去
 * （上级是同一批里刚新增的，入队时还没有 ID）。上级还没成功就报错，等上级任务完成后重试。
 */
export async function beforeJobSend(ctx: JobCtx, job: OutboxJob): Promise<Record<string, unknown>> {
  const p = job.payloadJson;
  if (job.kind !== 'category_sync') return p;
  const desired = { ...((p.desired ?? {}) as Record<string, unknown>) };
  const target = str(p.targetKey) || 'default';
  if (desired.parentLocalId != null && desired.parentLocalId !== '0') {
    const [up] = await ctx.ds.query("SELECT remote_id FROM jst_category_links WHERE company_id = ? AND target_key = ? AND category_id = ? AND status = 'linked'", [job.companyId, target, Number(desired.parentLocalId)]);
    if (!up?.remote_id) throw new Error('上级分类还没有同步成功，稍后自动重试');
    desired.parentRemoteId = String(up.remote_id);
  } else if (desired.parentRemoteId == null) desired.parentRemoteId = '0';
  await ctx.ds.query(
    `INSERT INTO jst_category_links (company_id, category_id, target_key, remote_id, status, local_json, pending_json) VALUES (?, ?, ?, ?, 'uncertain', ?, ?)
     ON DUPLICATE KEY UPDATE pending_json = VALUES(pending_json), status = 'uncertain'`,
    [job.companyId, job.resourceId, target, str(p.remoteId) || null, JSON.stringify(p.local ?? {}), JSON.stringify({ name: desired.name, parentId: desired.parentRemoteId, sort: desired.sort, enable: desired.enable })]);
  return { ...p, desired };
}
