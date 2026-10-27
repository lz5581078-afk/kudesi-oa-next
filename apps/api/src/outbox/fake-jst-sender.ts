import { OutboxSender } from './outbox.service';

/** 测试用假发送器：不连任何外部系统，记录收到的内容，可模拟失败、回读差异、换账号。 */
export class FakeJstSender implements OutboxSender {
  configured = true;
  targetKey?: string;
  sent: { kind: string; idempotencyKey: string; payload: Record<string, unknown> }[] = [];
  remote = new Map<string, Record<string, unknown>>();
  failNext: Error | null = null;
  readMode: 'ok' | 'mismatch' | 'throw' | 'missing' = 'ok';
  async send(job: { kind: string; idempotencyKey: string; payload: Record<string, unknown> }): Promise<void> {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.sent.push(job);
    this.remote.set(String(job.payload.sku_id), job.payload);
  }
  async read(skuId: string): Promise<Record<string, unknown> | null> {
    if (this.readMode === 'throw') throw new Error('读超时');
    if (this.readMode === 'missing') return null;
    const r = this.remote.get(skuId);
    if (!r) return null;
    return this.readMode === 'mismatch' ? { ...r, childList: [] } : r;
  }
}
