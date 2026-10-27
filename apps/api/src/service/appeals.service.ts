import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { APPEAL_TEMPLATE, SOON_MS, caseStage, isOpenStage } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowService } from '../flow/flow.service';
import { UploadedFile } from '../integrations/files.service';
import { APPEAL_FILES, CaseSupport, activeStepSql, keywordTokens, likeOf, parseRecipients } from './case-support';

export type AppealStatusFilter = 'all' | 'pending' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
export interface AppealCreate {
  storeId: number; appealType: string; orderNo: string; amountCents: number; reason: string; deadlineDate?: string; parentId?: number; requestKey?: string;
}

/** 订单申诉与举证。凭证（evidence）可以在办理过程中随时补充；提交平台前必须有凭证（见适配器）。 */
@Injectable()
export class AppealsService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly support: CaseSupport) {}

  /** 经营中的店铺（有当前运营、已领取）和各自的在办申诉数；旧系统按店铺进入申诉工作台。 */
  async stores(user: AuthUser) {
    const now = new Date();
    const rows = await this.ds.query(
      `SELECT s.id, s.title AS name, s.status, JSON_UNQUOTE(JSON_EXTRACT(s.data, '$.platform')) AS platform, JSON_UNQUOTE(JSON_EXTRACT(s.data, '$.storeNo')) AS storeNo,
              JSON_UNQUOTE(JSON_EXTRACT(s.data, '$.operatorUserId')) AS operatorId,
              (SELECT COUNT(*) FROM order_appeals a JOIN flow_runs r ON r.id = a.run_id WHERE a.company_id = s.company_id AND a.store_id = s.id AND r.status = 'running') AS open,
              (SELECT COUNT(*) FROM order_appeals a JOIN flow_runs r ON r.id = a.run_id WHERE a.company_id = s.company_id AND a.store_id = s.id AND r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ?) AS late
         FROM resource_records s
        WHERE s.company_id = ? AND s.type = 'stores' AND s.archived_at IS NULL AND s.status IN ('normal', 'abnormal')
          AND JSON_UNQUOTE(JSON_EXTRACT(s.data, '$.claimStatus')) = 'claimed' AND JSON_TYPE(JSON_EXTRACT(s.data, '$.operatorUserId')) = 'INTEGER'
        ORDER BY s.title LIMIT 2000`, [now, user.companyId]);
    const names = await this.support.userNames(user.companyId, rows.map((r: { operatorId: string | null }) => Number(r.operatorId)));
    return rows.map((r: { id: number; name: string; status: string; platform: string | null; storeNo: string | null; operatorId: string | null; open: string; late: string }) => ({
      id: r.id, name: r.name, status: r.status, platform: r.platform, storeNo: r.storeNo, operatorName: r.operatorId ? names.get(Number(r.operatorId)) ?? '' : '', open: Number(r.open), late: Number(r.late),
    }));
  }

  private async stats(user: AuthUser, storeId: number | undefined, now: Date) {
    const sw = storeId ? 'AND a.store_id = ?' : '';
    const args = (extra: unknown[]) => [...extra, user.companyId, ...(storeId ? [storeId] : [])];
    const month = new Date(`${new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 7)}-01T00:00:00+08:00`);
    const soon = new Date(now.getTime() + SOON_MS);
    const [row] = await this.ds.query(
      `SELECT SUM(r.status = 'running') AS open,
              SUM(r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ?) AS late,
              SUM(r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at >= ? AND r.due_at < ?) AS soon,
              SUM(r.status = 'running' AND r.current_step_key = 'submit') AS toSubmit,
              SUM(r.status = 'running' AND r.current_step_key = 'result') AS awaiting,
              SUM(a.appeal_type = 'reconsider' AND a.created_at >= ?) AS monthReconsider,
              SUM(r.status = 'completed' AND a.result = 'rejected' AND NOT EXISTS (SELECT 1 FROM order_appeals c WHERE c.company_id = a.company_id AND c.parent_id = a.id)) AS canReconsider,
              COALESCE(SUM(CASE WHEN r.status = 'running' THEN a.amount_cents END), 0) AS openAmount
         FROM order_appeals a JOIN flow_runs r ON r.id = a.run_id WHERE a.company_id = ? ${sw}`, args([now, now, soon, month]));
    return {
      open: Number(row.open ?? 0), late: Number(row.late ?? 0), soon: Number(row.soon ?? 0), toSubmit: Number(row.toSubmit ?? 0), awaiting: Number(row.awaiting ?? 0),
      monthReconsider: Number(row.monthReconsider ?? 0), canReconsider: Number(row.canReconsider ?? 0), openAmountCents: Number(row.openAmount ?? 0),
    };
  }

  async list(user: AuthUser, q: { storeId?: number; type?: string; status: AppealStatusFilter; keyword?: string; page: number; pageSize: number }) {
    const now = new Date();
    const where = ['a.company_id = ?'];
    const args: unknown[] = [user.companyId];
    if (q.storeId) { where.push('a.store_id = ?'); args.push(q.storeId); }
    if (q.type) { where.push('a.appeal_type = ?'); args.push(q.type); }
    if (q.status === 'pending') where.push("r.status = 'running' AND r.current_step_key <> 'result'");
    if (q.status === 'submitted') where.push("r.status = 'running' AND r.current_step_key = 'result'");
    if (q.status === 'approved') where.push("r.status = 'completed' AND a.result = 'approved'");
    if (q.status === 'rejected') where.push("r.status = 'completed' AND a.result = 'rejected'");
    if (q.status === 'cancelled') where.push("r.status IN ('cancelled', 'rejected')");
    const tokens = keywordTokens(q.keyword);
    if (tokens.length) {
      where.push(`(${tokens.map(() => '(a.order_no LIKE ? OR a.appeal_no LIKE ? OR a.platform_appeal_no LIKE ?)').join(' OR ')})`);
      for (const t of tokens) args.push(likeOf(t), likeOf(t), likeOf(t));
    }
    const w = where.join(' AND ');
    const from = `FROM order_appeals a JOIN flow_runs r ON r.id = a.run_id LEFT JOIN resource_records s ON s.id = a.store_id AND s.company_id = a.company_id LEFT JOIN users u ON u.id = a.created_by WHERE ${w}`;
    const [{ n }] = await this.ds.query(`SELECT COUNT(*) AS n ${from}`, args);
    const rows = await this.ds.query(
      `SELECT a.id, a.appeal_no AS appealNo, a.run_id AS runId, a.store_id AS storeId, s.title AS storeName, a.appeal_type AS appealType, a.order_no AS orderNo, a.amount_cents AS amountCents,
              a.reason, a.deadline_at AS deadlineAt, a.platform_appeal_no AS platformAppealNo, a.result, a.result_note AS resultNote, a.parent_id AS parentId, a.created_at AS createdAt, a.finished_at AS finishedAt,
              u.name AS createdByName, r.status AS runStatus, r.current_step_key AS stepKey, r.due_at AS dueAt, JSON_LENGTH(COALESCE(a.evidence, JSON_ARRAY())) AS evidenceCount,
              EXISTS (SELECT 1 FROM order_appeals c WHERE c.company_id = a.company_id AND c.parent_id = a.id) AS hasReconsider,
              ${activeStepSql('step_name')} AS stepName, ${activeStepSql('entered_via')} AS enteredVia, ${activeStepSql('recipients')} AS recipients
         ${from} ORDER BY (r.status = 'running') DESC, (r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ?) DESC, r.due_at IS NULL, r.due_at ASC, a.id DESC LIMIT ? OFFSET ?`,
      [...args, now, q.pageSize, (q.page - 1) * q.pageSize]);
    const names = await this.support.userNames(user.companyId, rows.flatMap((r: { recipients: unknown }) => parseRecipients(r.recipients)));
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize, stats: await this.stats(user, q.storeId, now),
      rows: rows.map((r: Record<string, unknown>) => this.row(r, names, now)),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private row(r: Record<string, unknown>, names: Map<number, string>, now: Date): Record<string, any> {
    const stage = caseStage(APPEAL_TEMPLATE, String(r.runStatus), (r.stepKey as string | null) ?? null);
    const open = isOpenStage(stage);
    const due = open && r.dueAt ? new Date(String(r.dueAt)) : null;
    return {
      ...r, recipients: undefined, runStatus: undefined, enteredVia: undefined, returnedBack: open && r.enteredVia === 'return', amountCents: Number(r.amountCents ?? 0), stage, open, dueAt: due, overdue: !!due && due < now, handlers: parseRecipients(r.recipients).map((id) => names.get(id) ?? ''),
      evidenceCount: Number(r.evidenceCount ?? 0), canReconsider: r.runStatus === 'completed' && r.result === 'rejected' && !Number(r.hasReconsider), hasReconsider: undefined,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async detail(user: AuthUser, id: number): Promise<Record<string, any>> {
    const now = new Date();
    const [r] = await this.ds.query(
      `SELECT a.id, a.appeal_no AS appealNo, a.run_id AS runId, a.store_id AS storeId, s.title AS storeName, a.appeal_type AS appealType, a.order_no AS orderNo, a.amount_cents AS amountCents,
              a.reason, a.deadline_at AS deadlineAt, a.platform_appeal_no AS platformAppealNo, a.submitted_at AS submittedAt, a.result, a.result_note AS resultNote, a.parent_id AS parentId,
              a.source, a.created_at AS createdAt, a.finished_at AS finishedAt, u.name AS createdByName, a.evidence, r.status AS runStatus, r.current_step_key AS stepKey, r.due_at AS dueAt,
              r.escalate_user_ids AS escalateUserIds, JSON_LENGTH(COALESCE(a.evidence, JSON_ARRAY())) AS evidenceCount,
              EXISTS (SELECT 1 FROM order_appeals c WHERE c.company_id = a.company_id AND c.parent_id = a.id) AS hasReconsider,
              ${activeStepSql('step_name')} AS stepName, ${activeStepSql('entered_via')} AS enteredVia, ${activeStepSql('recipients')} AS recipients
         FROM order_appeals a JOIN flow_runs r ON r.id = a.run_id LEFT JOIN resource_records s ON s.id = a.store_id AND s.company_id = a.company_id LEFT JOIN users u ON u.id = a.created_by
        WHERE a.id = ? AND a.company_id = ?`, [id, user.companyId]);
    if (!r) throw new NotFoundException('申诉不存在');
    const esc = parseRecipients(r.escalateUserIds);
    const names = await this.support.userNames(user.companyId, [...parseRecipients(r.recipients), ...esc]);
    const chain = await this.ds.query(
      `SELECT a.id, a.appeal_no AS appealNo, a.appeal_type AS appealType, a.result, a.created_at AS createdAt, r.status AS runStatus
         FROM order_appeals a JOIN flow_runs r ON r.id = a.run_id WHERE a.company_id = ? AND a.order_no = ? AND a.id <> ? AND a.store_id = ? ORDER BY a.id DESC LIMIT 20`, [user.companyId, r.orderNo, id, r.storeId]);
    const base = this.row(r, names, now) as Record<string, unknown>;
    return {
      ...base, evidence: undefined, escalateUserIds: undefined, supervisors: esc.map((u) => names.get(u) ?? '').filter(Boolean),
      files: await this.support.fileInfos(user.companyId, r.evidence),
      logs: await this.support.logs(user.companyId, 'appeal', id),
      sameOrder: chain.map((o: Record<string, unknown>) => ({ ...o, stage: caseStage(APPEAL_TEMPLATE, String(o.runStatus), null) })),
    };
  }

  async create(user: AuthUser, b: AppealCreate) {
    const payload: Record<string, unknown> = { storeId: b.storeId, appealType: b.appealType, orderNo: b.orderNo, amountCents: b.amountCents, reason: b.reason };
    if (b.deadlineDate) payload.deadlineDate = b.deadlineDate;
    if (b.parentId) payload.parentId = b.parentId;
    const run = await this.flow.start(user, APPEAL_TEMPLATE, payload, b.requestKey, { internal: true });
    const [a] = await this.ds.query('SELECT id FROM order_appeals WHERE run_id = ? AND company_id = ?', [run.id, user.companyId]);
    if (!a) throw new BadRequestException('登记失败，请重试');
    return { id: Number(a.id), runId: run.id };
  }

  addLog(user: AuthUser, id: number, content: string, kind: 'note' | 'urge') { return this.support.addLog(user, APPEAL_FILES, id, content, kind); }
  upload(user: AuthUser, id: number, file: UploadedFile | undefined) { return this.support.addFile(user, APPEAL_FILES, id, file); }
  removeFile(user: AuthUser, id: number, fileId: number) { return this.support.removeFile(user, APPEAL_FILES, id, fileId); }
  fileUrl(user: AuthUser, id: number, fileId: number) { return this.support.fileUrl(user, APPEAL_FILES, id, fileId); }
}
