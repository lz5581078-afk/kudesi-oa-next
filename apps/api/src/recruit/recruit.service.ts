import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { createChecker, maskIdNo, normalizeRecruitForm, recruitFormProblems, RECRUIT_STATUSES, SPECIAL_PERMISSIONS, type RecruitForm } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { Company, User } from '../entities';
import { liveManagementRecipients } from '../live/live-management-recipients';
import { writeNotification } from '../outbox/write-notification';
import { OcrService } from '../integrations/ocr.service';
import { UploadedFile } from '../integrations/files.service';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export const validRecruitToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as unknown;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

@Injectable()
export class RecruitService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly crypto: CryptoService, private readonly ocr: OcrService) {}

  private manage(actor: AuthUser) {
    if (!createChecker(actor.permissions)(SPECIAL_PERMISSIONS.recruitManage)) throw new ForbiddenException('没有招聘管理权限');
  }
  private audit(em: EntityManager, actor: AuthUser, action: string, id: number, detail: Record<string, unknown> = {}) {
    return em.query('INSERT INTO audit_logs (company_id, actor_id, action, resource_type, resource_id, detail) VALUES (?,?,?,?,?,?)',
      [actor.companyId, actor.id, action, 'recruit', String(id), JSON.stringify(detail)]);
  }
  private event(em: EntityManager, companyId: number, applicationId: number, type: string, actorId: number | null, detail: Record<string, unknown> | null = null) {
    return em.query('INSERT INTO recruit_events (company_id, application_id, event_type, actor_id, detail_json) VALUES (?,?,?,?,?)',
      [companyId, applicationId, type, actorId, detail ? JSON.stringify(detail) : null]);
  }

  // ───────────── 后台：招聘二维码 ─────────────
  async listInvites(actor: AuthUser) {
    const rows = await this.ds.query(`SELECT i.id, i.label, i.channel, i.token_enc, i.revoked_at, i.created_at, u.name creator_name,
        (SELECT COUNT(*) FROM recruit_applications a WHERE a.company_id=i.company_id AND a.invite_id=i.id) application_count
      FROM recruit_invites i LEFT JOIN users u ON u.id=i.created_by AND u.company_id=i.company_id
      WHERE i.company_id=? ORDER BY i.id DESC LIMIT 100`, [actor.companyId]);
    const canManage = createChecker(actor.permissions)(SPECIAL_PERMISSIONS.recruitManage);
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id), label: r.label, channel: r.channel, creatorName: r.creator_name ?? '', applicationCount: Number(r.application_count),
      revokedAt: iso(r.revoked_at as Date | null), createdAt: iso(r.created_at as Date),
      token: canManage && !r.revoked_at ? this.crypto.decrypt(String(r.token_enc)) : null,
    }));
  }
  async createInvite(actor: AuthUser, input: { label: string; channel?: string }) {
    this.manage(actor);
    const label = input.label.trim(), channel = input.channel?.trim() || null;
    if (!label) throw new BadRequestException('请填写二维码名称');
    const token = randomBytes(32).toString('base64url');
    const id = await this.ds.transaction(async em => {
      const company = await em.findOne(Company, { where: { id: actor.companyId, status: 'active' } });
      if (!company) throw new ForbiddenException('公司已停用');
      const res = await em.query('INSERT INTO recruit_invites (company_id,label,channel,token_hash,token_enc,created_by) VALUES (?,?,?,?,?,?)',
        [actor.companyId, label, channel, digest(token), this.crypto.encrypt(token), actor.id]);
      await this.audit(em, actor, 'recruit.invite.create', Number(res.insertId), { label, channel });
      return Number(res.insertId);
    });
    return { id, token };
  }
  async revokeInvite(actor: AuthUser, id: number) {
    this.manage(actor);
    await this.ds.transaction(async em => {
      const [row] = await em.query('SELECT id, revoked_at FROM recruit_invites WHERE company_id=? AND id=? FOR UPDATE', [actor.companyId, id]);
      if (!row) throw new NotFoundException('没有这个招聘二维码');
      if (row.revoked_at) return;
      await em.query('UPDATE recruit_invites SET revoked_at=NOW() WHERE company_id=? AND id=?', [actor.companyId, id]);
      await this.audit(em, actor, 'recruit.invite.revoke', id);
    });
    return { ok: true };
  }

  // ───────────── 后台：求职者 ─────────────
  async listApplications(actor: AuthUser, q: { keyword?: string; handler?: 'mine' | 'none' | 'any'; page?: number }) {
    const where = ['a.company_id=?']; const args: unknown[] = [actor.companyId];
    const kw = q.keyword?.trim();
    if (kw) { where.push('(a.name LIKE ? OR a.phone LIKE ?)'); args.push(`%${kw}%`, `%${kw}%`); }
    if (q.handler === 'mine') { where.push('a.handler_id=?'); args.push(actor.id); }
    if (q.handler === 'none') where.push('a.handler_id IS NULL');
    const page = Math.max(1, Math.floor(q.page ?? 1)), size = 30;
    const [{ n }] = await this.ds.query(`SELECT COUNT(*) n FROM recruit_applications a WHERE ${where.join(' AND ')}`, args);
    const rows = await this.ds.query(`SELECT a.id, a.name, a.gender, a.education, a.school, a.expected_salary, a.phone, a.source_channel, a.source_mode, a.status,
        a.handler_id, a.handled_at, a.created_at, h.name handler_name,
        (SELECT COUNT(*) FROM recruit_applications b WHERE b.company_id=a.company_id AND b.phone=a.phone) same_phone
      FROM recruit_applications a LEFT JOIN users h ON h.id=a.handler_id AND h.company_id=a.company_id
      WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]);
    return { total: Number(n), page, pageSize: size, rows: rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id), name: r.name, gender: r.gender, education: r.education, school: r.school, expectedSalary: r.expected_salary, phone: r.phone,
      sourceChannel: r.source_channel, sourceMode: r.source_mode, status: r.status, statusLabel: RECRUIT_STATUSES[r.status as keyof typeof RECRUIT_STATUSES] ?? String(r.status),
      handlerId: r.handler_id == null ? null : Number(r.handler_id), handlerName: r.handler_name ?? null, handledAt: iso(r.handled_at as Date | null),
      createdAt: iso(r.created_at as Date), samePhoneCount: Number(r.same_phone),
    })) };
  }
  async getApplication(actor: AuthUser, id: number) {
    const [r] = await this.ds.query(`SELECT a.*, h.name handler_name, i.label invite_label FROM recruit_applications a
      LEFT JOIN users h ON h.id=a.handler_id AND h.company_id=a.company_id
      LEFT JOIN recruit_invites i ON i.id=a.invite_id AND i.company_id=a.company_id
      WHERE a.company_id=? AND a.id=?`, [actor.companyId, id]);
    if (!r) throw new NotFoundException('没有这位求职者');
    const events = await this.ds.query(`SELECT e.id, e.event_type, e.detail_json, e.created_at, u.name actor_name FROM recruit_events e
      LEFT JOIN users u ON u.id=e.actor_id AND u.company_id=e.company_id WHERE e.company_id=? AND e.application_id=? ORDER BY e.id DESC LIMIT 100`, [actor.companyId, id]);
    return {
      id: Number(r.id), status: r.status, statusLabel: RECRUIT_STATUSES[r.status as keyof typeof RECRUIT_STATUSES] ?? String(r.status),
      sourceMode: r.source_mode, inviteLabel: r.invite_label ?? '', handlerId: r.handler_id == null ? null : Number(r.handler_id), handlerName: r.handler_name ?? null,
      handledAt: iso(r.handled_at), createdAt: iso(r.created_at),
      canViewId: createChecker(actor.permissions)(SPECIAL_PERMISSIONS.recruitIdView),
      form: {
        name: r.name, gender: r.gender, ethnicity: r.ethnicity ?? '', birthDate: String(r.birth_date instanceof Date ? r.birth_date.toISOString().slice(0, 10) : r.birth_date).slice(0, 10),
        marital: r.marital ?? '', education: r.education, school: r.school ?? '', graduationDate: r.graduation_date ?? '', expectedSalary: r.expected_salary ?? '',
        idNo: r.id_no_masked, phone: r.phone, educationHistory: json(r.education_json), workHistory: json(r.work_json),
        achievements: r.achievements ?? '', selfEvaluation: r.self_evaluation ?? '', sourceChannel: r.source_channel,
      },
      events: events.map((e: Record<string, unknown>) => ({ id: Number(e.id), type: e.event_type, actorName: e.actor_name ?? '求职者本人', detail: e.detail_json ? json(e.detail_json) : null, createdAt: iso(e.created_at as Date) })),
    };
  }
  /** 看身份证号明文：要专门权限，每次写审计和跟进记录 */
  async revealId(actor: AuthUser, id: number, purpose: 'view' | 'print') {
    if (!createChecker(actor.permissions)(SPECIAL_PERMISSIONS.recruitIdView)) throw new ForbiddenException('没有查看身份证号的权限');
    return this.ds.transaction(async em => {
      const [r] = await em.query('SELECT id_no_enc FROM recruit_applications WHERE company_id=? AND id=?', [actor.companyId, id]);
      if (!r) throw new NotFoundException('没有这位求职者');
      await this.audit(em, actor, 'recruit.id.view', id, { purpose });
      await this.event(em, actor.companyId, id, 'id_view', actor.id, { purpose });
      return { idNo: this.crypto.decrypt(String(r.id_no_enc)) };
    });
  }
  /** HR 认领跟进：只有没人接手时才能认领，之后的转交以后走流程 */
  async claim(actor: AuthUser, id: number) {
    this.manage(actor);
    await this.ds.transaction(async em => {
      const [r] = await em.query('SELECT id, handler_id FROM recruit_applications WHERE company_id=? AND id=? FOR UPDATE', [actor.companyId, id]);
      if (!r) throw new NotFoundException('没有这位求职者');
      if (r.handler_id != null && Number(r.handler_id) !== actor.id) throw new ConflictException('已经有同事在跟进这位求职者');
      if (r.handler_id != null) return;
      await em.query('UPDATE recruit_applications SET handler_id=?, handled_at=NOW() WHERE company_id=? AND id=?', [actor.id, actor.companyId, id]);
      await this.event(em, actor.companyId, id, 'claimed', actor.id);
    });
    return { ok: true };
  }
  /** 打印留痕：谁在什么时候打印了资料，方便了解人事工作 */
  async recordPrint(actor: AuthUser, id: number, withId: boolean) {
    const [r] = await this.ds.query('SELECT id FROM recruit_applications WHERE company_id=? AND id=?', [actor.companyId, id]);
    if (!r) throw new NotFoundException('没有这位求职者');
    await this.event(this.ds.manager, actor.companyId, id, 'printed', actor.id, { withId });
    return { ok: true };
  }
  /** 人事工作量：每位人事认领、打印的数量 */
  async stats(actor: AuthUser) {
    const rows = await this.ds.query(`SELECT u.id, u.name,
        (SELECT COUNT(*) FROM recruit_applications a WHERE a.company_id=u.company_id AND a.handler_id=u.id) claimed,
        (SELECT COUNT(*) FROM recruit_events e WHERE e.company_id=u.company_id AND e.actor_id=u.id AND e.event_type='printed') printed
      FROM users u WHERE u.company_id=? AND (EXISTS (SELECT 1 FROM recruit_applications a WHERE a.company_id=u.company_id AND a.handler_id=u.id)
        OR EXISTS (SELECT 1 FROM recruit_events e WHERE e.company_id=u.company_id AND e.actor_id=u.id)) ORDER BY claimed DESC, u.id`, [actor.companyId]);
    const [t] = await this.ds.query(`SELECT COUNT(*) total, SUM(handler_id IS NULL) unclaimed FROM recruit_applications WHERE company_id=?`, [actor.companyId]);
    return { total: Number(t.total), unclaimed: Number(t.unclaimed ?? 0), handlers: rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: r.name, claimed: Number(r.claimed), printed: Number(r.printed) })) };
  }

  // ───────────── 求职者（不登录，只凭二维码令牌）─────────────
  private async resolve(em: EntityManager, token: unknown) {
    if (!validRecruitToken(token)) throw new NotFoundException('招聘二维码无效，请联系公司人事重新获取');
    const [invite] = await em.query(`SELECT i.id, i.company_id, i.label, i.channel, i.revoked_at, c.name company_name, c.status company_status FROM recruit_invites i
      JOIN companies c ON c.id=i.company_id WHERE i.token_hash=?`, [digest(token)]);
    if (!invite || invite.revoked_at || invite.company_status !== 'active') throw new NotFoundException('招聘二维码已失效，请联系公司人事重新获取');
    return { inviteId: Number(invite.id), companyId: Number(invite.company_id), companyName: String(invite.company_name), label: String(invite.label), channel: (invite.channel as string | null) ?? '' };
  }
  async preview(token: unknown) {
    const r = await this.resolve(this.ds.manager, token);
    return { companyName: r.companyName, channel: r.channel };
  }
  async recognize(token: unknown, file: UploadedFile | undefined) {
    const r = await this.resolve(this.ds.manager, token);
    const out = await this.ocr.recognizeResume(r.companyId, file);
    return { form: { ...out.form, sourceChannel: out.form.sourceChannel || r.channel }, filled: out.filled };
  }
  async submit(token: unknown, requestKey: string, sourceMode: 'manual' | 'image', input: unknown) {
    const form: RecruitForm = normalizeRecruitForm(input);
    const problems = recruitFormProblems(form);
    if (problems.length) throw new BadRequestException(problems.join('；'));
    const r = await this.resolve(this.ds.manager, token);
    const id = await this.ds.transaction(async em => {
      const [dup] = await em.query('SELECT id FROM recruit_applications WHERE company_id=? AND request_key=?', [r.companyId, requestKey]);
      if (dup) return Number(dup.id); // 网络重试，不重复登记
      const res = await em.query(`INSERT INTO recruit_applications (company_id,invite_id,request_key,source_mode,name,gender,ethnicity,birth_date,marital,education,school,graduation_date,
          expected_salary,id_no_enc,id_no_masked,phone,education_json,work_json,achievements,self_evaluation,source_channel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.companyId, r.inviteId, requestKey, sourceMode, form.name, form.gender, form.ethnicity || null, form.birthDate, form.marital || null, form.education, form.school || null,
          form.graduationDate || null, form.expectedSalary || null, this.crypto.encrypt(form.idNo), maskIdNo(form.idNo), form.phone,
          JSON.stringify(form.educationHistory), JSON.stringify(form.workHistory), form.achievements || null, form.selfEvaluation || null, form.sourceChannel]);
      const appId = Number(res.insertId);
      await this.event(em, r.companyId, appId, 'submitted', null, { mode: sourceMode, invite: r.label });
      const { hr, management } = await liveManagementRecipients(em, r.companyId);
      let recipients = [...new Set([...hr, ...management])];
      if (!recipients.length) recipients = (await em.find(User, { where: { companyId: r.companyId, isCompanyAdmin: true, status: 'active' }, select: ['id'] })).map(u => u.id);
      for (const userId of recipients) {
        await writeNotification(em, { companyId: r.companyId, userId, kind: 'recruit', title: `新的面试登记：${form.name}`,
          body: [form.education, form.school, form.expectedSalary && `期望 ${form.expectedSalary}`, `渠道：${form.sourceChannel}`].filter(Boolean).join(' · ').slice(0, 480),
          link: `/features/recruit?id=${appId}` }, { key: `recruit:${appId}`, resourceType: 'recruit', resourceId: appId });
      }
      return appId;
    });
    return { ok: true, id };
  }
}
