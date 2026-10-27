import { EntityManager } from 'typeorm';
import { normalizeSpecs } from '@kudesi/shared';
import { FlowRun, ResourceRecord } from '../entities';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 主品、赠品构成的指纹（只比运营填的这两类，和 SKU 申请的在办检查一致） */
const sig = (rows: Array<{ role: string; baseCodeId: number; qty: number }>) => rows.map((l) => `${l.role}:${l.baseCodeId}:${l.qty}`).sort().join('|');

/**
 * 还没办完的 SKU 批量申请里有没有用到这个组合（同场景、同平台、主品赠品构成一样）。
 * 旧系统：归档、发布构成修订前都要拦截“未完成 SKU 申请引用”，避免申请办到一半组合被改掉或归档。
 */
export async function unfinishedApplications(em: EntityManager, companyId: number, bundle: ResourceRecord, lines: ResourceRecord[]): Promise<{ runId: number; title: string } | null> {
  const mine = sig(lines.filter((l) => l.data.role === 'main' || l.data.role === 'gift').map((l) => ({ role: String(l.data.role), baseCodeId: Number(l.data.baseCodeId), qty: Number(l.data.qty) })));
  if (!mine) return null;
  const runs = await em.find(FlowRun, { where: { companyId, templateKey: 'sku-batch-apply', status: 'running' } });
  for (const r of runs) {
    if (num(r.payload.scenarioId) !== num(bundle.data.scenarioId)) continue;
    const platforms = Array.isArray(r.payload.platformIds) ? (r.payload.platformIds as unknown[]).map(Number) : [];
    if (!platforms.includes(Number(bundle.data.platformId))) continue;
    for (const s of normalizeSpecs(r.payload.specs).specs) {
      if (sig([...s.main.map((l) => ({ role: 'main', ...l })), ...s.gift.map((l) => ({ role: 'gift', ...l }))]) === mine) return { runId: r.id, title: r.title };
    }
  }
  return null;
}
