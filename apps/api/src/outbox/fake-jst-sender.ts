import { OutboxSender, RemoteCategory } from './outbox.service';

/** 测试用假发送器：不连任何外部系统，记录收到的内容，可模拟失败、回读差异、换账号。 */
export class FakeJstSender implements OutboxSender {
  configured = true;
  targetKey?: string;
  sent: { kind: string; idempotencyKey: string; payload: Record<string, unknown> }[] = [];
  remote = new Map<string, Record<string, unknown>>();
  /** 假的聚水潭分类（分类同步用）：id → 分类 */
  categories = new Map<string, RemoteCategory>();
  failNext: Error | null = null;
  readMode: 'ok' | 'mismatch' | 'throw' | 'missing' = 'ok';
  private nextCategoryId = 9000;
  async send(job: { kind: string; idempotencyKey: string; payload: Record<string, unknown> }): Promise<void | { remoteId?: string }> {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.sent.push(job);
    const p = job.payload;
    if (job.kind === 'category_sync') {
      const op = String(p.op);
      const d = (p.desired ?? {}) as { name?: string; parentRemoteId?: string; sort?: number | null };
      const id = String(p.remoteId ?? '') || String(this.nextCategoryId++);
      if (op === 'retire') { const c = this.categories.get(id); if (c) this.categories.set(id, { ...c, enable: false }); return { remoteId: id }; }
      this.categories.set(id, { id, name: d.name ?? '', parentId: d.parentRemoteId ?? '0', sort: d.sort ?? null, enable: true });
      return { remoteId: id };
    }
    const sku = String(p.sku_id);
    if (job.kind.endsWith('_disable')) { this.remote.set(sku, { ...(this.remote.get(sku) ?? p), enabled: '禁用' }); return; }
    if (job.kind === 'bundle_price_update') { this.remote.set(sku, { ...(this.remote.get(sku) ?? {}), sku_id: sku, compose_sale_price: p.compose_sale_price }); return; }
    this.remote.set(sku, p);
  }
  async read(skuId: string): Promise<Record<string, unknown> | null> {
    if (this.readMode === 'throw') throw new Error('读超时');
    if (this.readMode === 'missing') return null;
    const r = this.remote.get(skuId);
    if (!r) return null;
    return this.readMode === 'mismatch' ? { ...r, childList: [], compose_sale_price: -1 } : r;
  }
  async readCategories(): Promise<RemoteCategory[]> { return [...this.categories.values()]; }
}
