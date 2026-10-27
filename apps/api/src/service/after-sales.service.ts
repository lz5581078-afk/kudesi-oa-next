import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AFTER_SALES_TEMPLATE, SOON_MS, caseStage, isOpenStage, type CaseStage } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowService } from '../flow/flow.service';
import { UploadedFile } from '../integrations/files.service';
import { AFTER_SALES_FILES, CaseSupport, activeStepSql, keywordTokens, likeOf, parseRecipients } from './case-support';

export type CaseFilter = 'open' | 'late' | 'soon' | 'done' | 'all';
export interface CaseCreate {
  storeId: number; orderNo: string; buyerName?: string; caseType: string; amountCents: number; reason: string; dueDate?: string; requestKey?: string;
}

/** 售后工单：业务内容在 after_sales_cases，流转在统一流程引擎。所有查询带公司条件，身份只取令牌。 */
@Injectable()
export class AfterSalesService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly support: CaseSupport) {}

  /** 可选店铺（含运营人）；已注销的店铺不再出现。 */
  async stores(user: AuthUser) {
    const rows = await this.ds.query(
      `SELECT id, title AS name, status, JSON_UNQUOTE(JSON_EXTRACT(data, '$.platform')) AS platform, JSON_UNQUOTE(JSON_EXTRACT(data, '$.operatorUserId')) AS operatorId,
              JSON_UNQUOTE(JSON_EXTRACT(data, '$.claimStatus')) AS claimStatus
         FROM resource_records WHERE company_id = ? AND type = 'stores' AND archived_at IS NULL AND status NOT IN ('cancelled') ORDER BY title LIMIT 2000`, [user.companyId]);
    const names = await this.support.userNames(user.companyId, rows.map((r: { operatorId: string | null }) => Number(r.operatorId)));
    return rows.map((r: { id: number; name: string; status: string; platform: string | null; operatorId: string | null; claimStatus: string | null }) => ({
      id: r.id, name: r.name, status: r.status, platform: r.platform, claimStatus: r.claimStatus, operatorName: r.operatorId ? names.get(Number(r.operatorId)) ?? '' : '',
    }));
  }

  private async stats(user: AuthUser, now: Date) {
    const soon = new Date(now.getTime() + SOON_MS);
    const [row] = await this.ds.query(
      `SELECT SUM(r.status = 'running') AS open,
              SUM(r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ?) AS late,
              SUM(r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at >= ? AND r.due_at < ?) AS soon,
              SUM(r.status <> 'running') AS done, COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN r.status = 'running' THEN c.amount_cents END), 0) AS openAmount,
              COALESCE(SUM(CASE WHEN r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ? THEN c.amount_cents END), 0) AS lateAmount
         FROM after_sales_cases c JOIN flow_runs r ON r.id = c.run_id WHERE c.company_id = ?`, [now, now, soon, now, user.companyId]);
    return { open: Number(row.open ?? 0), late: Number(row.late ?? 0), soon: Number(row.soon ?? 0), done: Number(row.done ?? 0), total: Number(row.total ?? 0), openAmountCents: Number(row.openAmount), lateAmountCents: Number(row.lateAmount) };
  }

  async list(user: AuthUser, q: { filter: CaseFilter; keyword?: string; storeId?: number; caseType?: string; mine?: boolean; page: number; pageSize: number }) {
    const now = new Date();
    const where = ['c.company_id = ?'];
    const args: unknown[] = [user.companyId];
    if (q.filter === 'open') where.push("r.status = 'running'");
    if (q.filter === 'late') { where.push("r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ?"); args.push(now); }
    if (q.filter === 'soon') { where.push("r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at >= ? AND r.due_at < ?"); args.push(now, new Date(now.getTime() + SOON_MS)); }
    if (q.filter === 'done') where.push("r.status <> 'running'");
    if (q.storeId) { where.push('c.store_id = ?'); args.push(q.storeId); }
    if (q.caseType) { where.push('c.case_type = ?'); args.push(q.caseType); }
    if (q.mine) {
      where.push(`(c.created_by = ? OR EXISTS (SELECT 1 FROM work_items w WHERE w.run_id = r.id AND w.assignee_id = ? AND w.status = 'open'))`);
      args.push(user.id, user.id);
    }
    const tokens = keywordTokens(q.keyword);
    if (tokens.length) {
      where.push(`(${tokens.map(() => '(c.order_no LIKE ? OR c.buyer_name LIKE ? OR c.case_no LIKE ? OR s.title LIKE ? OR c.reason LIKE ?)').join(' OR ')})`);
      for (const t of tokens) args.push(likeOf(t), likeOf(t), likeOf(t), likeOf(t), likeOf(t));
    }
    const w = where.join(' AND ');
    const from = `FROM after_sales_cases c JOIN flow_runs r ON r.id = c.run_id LEFT JOIN resource_records s ON s.id = c.store_id AND s.company_id = c.company_id LEFT JOIN users u ON u.id = c.created_by WHERE ${w}`;
    const [{ n }] = await this.ds.query(`SELECT COUNT(*) AS n ${from}`, args);
    const rows = await this.ds.query(
      `SELECT c.id, c.case_no AS caseNo, c.run_id AS runId, c.store_id AS storeId, s.title AS storeName, c.order_no AS orderNo, c.buyer_name AS buyerName, c.case_type AS caseType,
              c.amount_cents AS amountCents, c.refund_cents AS refundCents, c.reason, c.created_at AS createdAt, c.finished_at AS finishedAt, u.name AS createdByName,
              r.status AS runStatus, r.current_step_key AS stepKey, r.due_at AS dueAt, JSON_LENGTH(COALESCE(c.attachments, JSON_ARRAY())) AS attachmentCount,
              ${activeStepSql('step_name')} AS stepName, ${activeStepSql('entered_via')} AS enteredVia, ${activeStepSql('recipients')} AS recipients
         ${from} ORDER BY (r.status = 'running') DESC, (r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ?) DESC, r.due_at IS NULL, r.due_at ASC, c.id DESC LIMIT ? OFFSET ?`,
      [...args, now, q.pageSize, (q.page - 1) * q.pageSize]);
    const names = await this.support.userNames(user.companyId, rows.flatMap((r: { recipients: unknown }) => parseRecipients(r.recipients)));
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize, stats: await this.stats(user, now),
      rows: rows.map((r: Record<string, unknown>) => this.row(r, names, now)),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private row(r: Record<string, unknown>, names: Map<number, string>, now: Date): Record<string, any> {
    const stage = caseStage(AFTER_SALES_TEMPLATE, String(r.runStatus), (r.stepKey as string | null) ?? null);
    const open = isOpenStage(stage);
    const due = open && r.dueAt ? new Date(String(r.dueAt)) : null;
    return {
      ...r, recipients: undefined, runStatus: undefined, enteredVia: undefined, returnedBack: open && r.enteredVia === 'return', amountCents: Number(r.amountCents ?? 0), stage, open, dueAt: due, overdue: !!due && due < now,
      handlers: parseRecipients(r.recipients).map((id) => names.get(id) ?? ''), attachmentCount: Number(r.attachmentCount ?? 0), refundCents: r.refundCents === null || r.refundCents === undefined ? null : Number(r.refundCents),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async detail(user: AuthUser, id: number): Promise<Record<string, any>> {
    const now = new Date();
    const [r] = await this.ds.query(
      `SELECT c.id, c.case_no AS caseNo, c.run_id AS runId, c.store_id AS storeId, s.title AS storeName, c.order_no AS orderNo, c.buyer_name AS buyerName, c.case_type AS caseType,
              c.amount_cents AS amountCents, c.refund_cents AS refundCents, c.reason, c.resolution, c.due_date AS dueDate, c.source, c.created_at AS createdAt, c.finished_at AS finishedAt,
              u.name AS createdByName, c.attachments, r.status AS runStatus, r.current_step_key AS stepKey, r.due_at AS dueAt, r.escalate_user_ids AS escalateUserIds,
              ${activeStepSql('step_name')} AS stepName, ${activeStepSql('entered_via')} AS enteredVia, ${activeStepSql('recipients')} AS recipients
         FROM after_sales_cases c JOIN flow_runs r ON r.id = c.run_id LEFT JOIN resource_records s ON s.id = c.store_id AND s.company_id = c.company_id LEFT JOIN users u ON u.id = c.created_by
        WHERE c.id = ? AND c.company_id = ?`, [id, user.companyId]);
    if (!r) throw new NotFoundException('售后工单不存在');
    const esc = parseRecipients(r.escalateUserIds);
    const names = await this.support.userNames(user.companyId, [...parseRecipients(r.recipients), ...esc]);
    const others = await this.ds.query(
      `SELECT c.id, c.case_no AS caseNo, c.case_type AS caseType, c.amount_cents AS amountCents, r.status AS runStatus, r.current_step_key AS stepKey, c.created_at AS createdAt
         FROM after_sales_cases c JOIN flow_runs r ON r.id = c.run_id WHERE c.company_id = ? AND c.order_no = ? AND c.id <> ? ORDER BY c.id DESC LIMIT 20`, [user.companyId, r.orderNo, id]);
    const base = this.row(r, names, now) as Record<string, unknown>;
    return {
      ...base, attachments: undefined, escalateUserIds: undefined, supervisors: esc.map((u) => names.get(u) ?? '').filter(Boolean),
      files: await this.support.fileInfos(user.companyId, r.attachments),
      logs: await this.support.logs(user.companyId, 'after_sales', id),
      sameOrder: others.map((o: Record<string, unknown>) => ({ ...o, runStatus: undefined, stage: caseStage(AFTER_SALES_TEMPLATE, String(o.runStatus), (o.stepKey as string | null) ?? null) as CaseStage, stepKey: undefined })),
    };
  }

  /** 登记工单：校验后交给流程引擎发起，引擎在同一个事务里通过适配器建工单记录。 */
  async create(user: AuthUser, b: CaseCreate) {
    const payload: Record<string, unknown> = { storeId: b.storeId, orderNo: b.orderNo, caseType: b.caseType, amountCents: b.amountCents, reason: b.reason };
    if (b.buyerName?.trim()) payload.buyerName = b.buyerName.trim();
    if (b.dueDate) payload.dueDate = b.dueDate;
    const run = await this.flow.start(user, AFTER_SALES_TEMPLATE, payload, b.requestKey, { internal: true });
    const [c] = await this.ds.query('SELECT id FROM after_sales_cases WHERE run_id = ? AND company_id = ?', [run.id, user.companyId]);
    if (!c) throw new BadRequestException('登记失败，请重试');
    return { id: Number(c.id), runId: run.id };
  }

  addLog(user: AuthUser, id: number, content: string, kind: 'note' | 'urge') { return this.support.addLog(user, AFTER_SALES_FILES, id, content, kind); }
  upload(user: AuthUser, id: number, file: UploadedFile | undefined) { return this.support.addFile(user, AFTER_SALES_FILES, id, file); }
  removeFile(user: AuthUser, id: number, fileId: number) { return this.support.removeFile(user, AFTER_SALES_FILES, id, fileId); }
  fileUrl(user: AuthUser, id: number, fileId: number) { return this.support.fileUrl(user, AFTER_SALES_FILES, id, fileId); }
}
