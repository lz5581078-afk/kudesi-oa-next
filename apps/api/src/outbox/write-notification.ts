import { EntityManager, InsertResult } from 'typeorm';
import { Notification, OutboxSwitch } from '../entities';
import type { FeishuNotice } from './feishu-notice.service';

type Input = Pick<Notification, 'companyId' | 'userId' | 'kind' | 'title' | 'body' | 'link'>;
type Delivery = Partial<Pick<FeishuNotice, 'channel' | 'resourceType' | 'resourceId' | 'kind' | 'runId'>> & { key?: string };

/** Persist the OA notice and its opt-in Feishu job in the same business transaction. No network calls. */
export async function writeNotification(em: EntityManager, input: Input, delivery: Delivery = {}): Promise<InsertResult & { feishuQueued: boolean }> {
  // Some standalone helpers use the root manager; they need the same atomicity as business transactions.
  if (!em.queryRunner?.isTransactionActive) return em.transaction(tx => writeNotification(tx, input, delivery));
  const saved = await em.insert(Notification, input);
  const result = Object.assign(saved, { feishuQueued: false });
  const sw = await em.findOne(OutboxSwitch, { where: { companyId: input.companyId, channel: 'feishu' } });
  if (!sw?.enabled) return result;
  const [binding] = await em.query(`SELECT b.id FROM feishu_identities b
    JOIN users u ON u.id=b.user_id AND u.company_id=b.company_id
    JOIN companies c ON c.id=b.company_id
    WHERE b.company_id=? AND b.user_id=? AND b.oa_notifications=1 AND u.status='active' AND c.status='active' LIMIT 1`, [input.companyId, input.userId]);
  if (!binding) return result;
  const id = Number(saved.identifiers[0]?.id);
  const { key, ...meta } = delivery;
  const notice: FeishuNotice = { channel: 'notice', ...meta, notificationId: id, userId: input.userId, title: input.title, body: input.body ?? undefined, link: input.link ?? undefined };
  await em.query(`INSERT IGNORE INTO outbox_jobs (company_id,channel,kind,resource_type,resource_id,idempotency_key,payload_json,created_by)
    VALUES (?,'feishu','feishu_notice',?,?,?,?,NULL)`, [input.companyId, meta.resourceType ?? 'notification', meta.resourceId ?? meta.runId ?? id,
    key ? `feishu:${key}:${input.userId}`.slice(0, 120) : `feishu:notification:${id}:${input.userId}`, JSON.stringify(notice)]);
  result.feishuQueued = true;
  return result;
}
