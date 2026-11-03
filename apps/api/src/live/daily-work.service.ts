import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { liveFromText, liveIsDay, liveToday } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowService } from '../flow/flow.service';
import { writeNotification } from '../outbox/write-notification';
import {
  loadLiveAccess,
  requireManage,
  requireUse,
  requireView,
} from './live-access';
import {
  closedDay,
  liveClock,
  liveFail,
  lockCompany,
  positionTypesOf,
  Row,
  wallNow,
} from './live-core';
import { dailyDto, dailyRow, dailySelect, dailyTime } from './daily-work-core';
import { liveManagementRecipients } from './live-management-recipients';

async function audit(
  em: EntityManager,
  u: AuthUser,
  id: number,
  action: string,
  detail: unknown,
) {
  await em.query(
    'INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES(?,?,?,?,?,?)',
    [
      u.companyId,
      u.id,
      action,
      'live-daily-work',
      String(id),
      JSON.stringify(detail),
    ],
  );
}
export async function dailyOverdue(em: EntityManager, r: Row, now: Date) {
  if (
    r.overdue_notified_at ||
    !r.actual_start ||
    +now <= +liveFromText(r.planned_end_text)! + 3600000
  )
    return;
  const { management } = await liveManagementRecipients(
    em,
    Number(r.company_id),
  );
  if (!management.length) return;
  for (const id of management) {
    const event = await em.query(
      'INSERT IGNORE INTO live_notification_events(company_id,event_key,user_id) VALUES(?,?,?)',
      [r.company_id, `daily-overdue:${r.id}`, id],
    );
    if (event.affectedRows)
      await writeNotification(
        em,
        {
          companyId: Number(r.company_id),
          userId: id,
          kind: 'live_notification',
          title: '日常工作超过排班结束时间1小时',
          body: `${r.user_name} · ${r.content}；计划 ${r.planned_start_text} 至 ${r.planned_end_text}，实际 ${r.actual_start_text} 开始，${r.actual_end ? '已超时结束' : '仍未结束'}。请核对实际工作与工时。`,
          link: '/features/live?tab=daily',
        },
        {
          key: `daily-overdue:${r.id}:${id}`,
          channel: 'supervision',
          resourceType: 'live-daily-work',
          resourceId: Number(r.id),
          kind: 'live-event',
        },
      );
  }
  await em.query(
    'UPDATE live_daily_work SET overdue_notified_at=? WHERE company_id=? AND id=?',
    [wallNow(now), r.company_id, r.id],
  );
}
@Injectable()
export class DailyWorkService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly flow: FlowService,
  ) {}
  async list(user: AuthUser, date?: string, mine = false) {
    const a = await loadLiveAccess(this.ds.manager, user);
    mine ? requireUse(a) : requireView(a);
    if (date && !liveIsDay(date)) liveFail('日期无效', 400);
    const now = liveClock.now(),
      where = ['w.company_id=?'],
      params: unknown[] = [user.companyId];
    if (date) {
      where.push("(w.work_date=? OR (w.status='working' AND ?=?))");
      params.push(date, date, liveToday(now));
    } else {
      where.push(
        "(w.work_date>=? OR w.status IN ('working','pending','returned','submitted'))",
      );
      params.push(liveToday(now));
    }
    if (mine) {
      where.push('w.user_id=?');
      params.push(user.id);
    }
    const rows: Row[] = await this.ds.query(
      `${dailySelect} WHERE ${where.join(' AND ')} ORDER BY w.planned_start,w.id LIMIT 500`,
      params,
    );
    const month = (date ?? liveToday(now)).slice(0, 7);
    const [total] = mine
      ? await this.ds.query(
          "SELECT COALESCE(SUM(amount_cents),0) amount,COALESCE(SUM(COALESCE(approved_minutes,minutes)),0) minutes FROM live_daily_work WHERE company_id=? AND user_id=? AND status='approved' AND work_date>=? AND work_date<LAST_DAY(CONCAT(?,'-01'))+INTERVAL 1 DAY",
          [user.companyId, user.id, month + '-01', month],
        )
      : [];
    return {
      monthTotal: total
        ? {
            month,
            amountCents: Number(total.amount),
            minutes: Number(total.minutes),
          }
        : undefined,
      now: wallNow(now),
      canManage: a.canManage,
      rows: rows.map((r) =>
        dailyDto(
          r,
          a.canManage || a.canViewAll || Number(r.user_id) === user.id,
          now,
        ),
      ),
    };
  }
  async options(user: AuthUser) {
    requireManage(await loadLiveAccess(this.ds.manager, user));
    const users: Row[] = await this.ds.query(
      "SELECT id,name,hourly_rate FROM users WHERE company_id=? AND status='active' AND pay_type='hourly' AND hourly_rate>0 ORDER BY name,id",
      [user.companyId],
    );
    const people = [];
    for (const u of users) {
      const types = await positionTypesOf(
        this.ds.manager,
        user.companyId,
        Number(u.id),
      );
      const roles = (['anchor', 'control'] as const).filter((r) =>
        types.has(r === 'anchor' ? 'live_anchor' : 'live_control'),
      );
      if (roles.length)
        people.push({
          id: Number(u.id),
          name: u.name,
          hourlyRateCents: Number(u.hourly_rate),
          roles,
        });
    }
    return people;
  }
  async schedule(
    user: AuthUser,
    input: {
      userId: number;
      role: 'anchor' | 'control';
      startAt: string;
      endAt: string;
      content: string;
    },
  ) {
    requireManage(await loadLiveAccess(this.ds.manager, user));
    const start = dailyTime(input.startAt),
      end = dailyTime(input.endAt),
      content = input.content.trim();
    const duration = +liveFromText(end)! - +liveFromText(start)!;
    if (!content || duration <= 0 || duration > 16 * 3600000)
      liveFail('请填写工作内容和开始/结束时间，单段最长16小时', 400);
    return this.ds.transaction(async (em) => {
      await lockCompany(em, user.companyId);
      if (await closedDay(em, user.companyId, start.slice(0, 10)))
        liveFail('该日期已经进入工资结算，不能新增排班');
      const [person] = await em.query(
        'SELECT id,status,pay_type,hourly_rate FROM users WHERE company_id=? AND id=?',
        [user.companyId, input.userId],
      );
      const types = await positionTypesOf(em, user.companyId, input.userId);
      if (
        !person ||
        person.status !== 'active' ||
        !types.has(input.role === 'anchor' ? 'live_anchor' : 'live_control')
      )
        liveFail('只能为在职主播或中控安排日常工作', 400);
      if (person.pay_type !== 'hourly' || Number(person.hourly_rate) <= 0)
        liveFail('请先在人事档案维护该员工的时薪', 400);
      const [clash] = await em.query(
        "SELECT id FROM live_daily_work WHERE company_id=? AND user_id=? AND status<>'cancelled' AND planned_start<? AND planned_end>? LIMIT 1",
        [user.companyId, input.userId, end, start],
      );
      const [live] = await em.query(
        "SELECT id FROM live_schedules WHERE company_id=? AND status<>'cancelled' AND (anchor_user_id=? OR control_user_id=? OR operator_user_id=?) AND start_at<? AND end_at>? LIMIT 1",
        [user.companyId, input.userId, input.userId, input.userId, end, start],
      );
      if (clash || live)
        liveFail('人员在该时间已有日常工作或直播排班，请调整时间');
      const res = await em.query(
        'INSERT INTO live_daily_work(company_id,user_id,role,work_date,planned_start,planned_end,content,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?)',
        [
          user.companyId,
          input.userId,
          input.role,
          start.slice(0, 10),
          start,
          end,
          content,
          user.id,
          user.id,
        ],
      );
      const id = Number(res.insertId);
      await audit(em, user, id, 'live.daily.schedule', input);
      await writeNotification(
        em,
        {
          companyId: user.companyId,
          userId: input.userId,
          kind: 'live_notification',
          title: '新增日常工作排班',
          body: `直播办公室 · ${content}；${start} 至 ${end}，仅在排班时间内可开始。`,
          link: '/features/live-desk?daily=1',
        },
        {
          key: `daily-schedule:${id}`,
          channel: 'live',
          resourceType: 'live-daily-work',
          resourceId: id,
        },
      );
      return { id };
    });
  }
  async cancel(user: AuthUser, id: number, reason: string) {
    requireManage(await loadLiveAccess(this.ds.manager, user));
    if (!reason.trim()) liveFail('请填写取消原因', 400);
    return this.ds.transaction(async (em) => {
      const r = await dailyRow(em, user.companyId, id, true);
      if (r.status !== 'scheduled') liveFail('只有未开始的排班可以取消');
      await em.query(
        "UPDATE live_daily_work SET status='cancelled',return_reason=?,updated_by=? WHERE company_id=? AND id=?",
        [reason.trim(), user.id, user.companyId, id],
      );
      await audit(em, user, id, 'live.daily.cancel', { reason });
      return { ok: true };
    });
  }
  async start(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.ds.manager, user);
    requireUse(a);
    return this.ds.transaction(async (em) => {
      const r = await dailyRow(em, user.companyId, id, true),
        now = liveClock.now(),
        wall = wallNow(now);
      if (Number(r.user_id) !== user.id)
        liveFail('只能开始本人的日常工作', 403);
      if (r.status !== 'scheduled')
        liveFail('该排班已开始、结束或取消，请刷新');
      if (
        +now < +liveFromText(r.planned_start_text)! ||
        +now >= +liveFromText(r.planned_end_text)!
      )
        liveFail('只能在排班开始与结束时间内开始日常工作');
      if (await closedDay(em, user.companyId, r.day))
        liveFail('该日期已进入工资结算，不能开始');
      const types = await positionTypesOf(em, user.companyId, user.id);
      if (!types.has(r.role === 'anchor' ? 'live_anchor' : 'live_control'))
        liveFail('当前岗位已不具备本排班身份', 403);
      const [person] = await em.query(
        "SELECT hourly_rate FROM users WHERE company_id=? AND id=? AND status='active' AND pay_type='hourly' AND hourly_rate>0",
        [user.companyId, user.id],
      );
      if (!person) liveFail('请先维护有效的在职时薪档案');
      const [busy] = await em.query(
        "SELECT id FROM live_daily_work WHERE company_id=? AND user_id=? AND status='working' LIMIT 1",
        [user.companyId, user.id],
      );
      const [live] = await em.query(
        `SELECT s.id FROM live_sessions s LEFT JOIN live_session_checkins ci ON ci.company_id=s.company_id AND ci.session_id=s.id AND ci.user_id=? WHERE s.company_id=? AND ((ci.id IS NOT NULL AND ci.end_at IS NULL) OR (s.checkin_mode=0 AND s.status='live' AND (s.anchor_user_id=? OR s.control_user_id=? OR s.operator_user_id=?))) AND s.status IN ('live','pending_report') AND s.report_locked_at IS NULL AND (s.report_deadline IS NULL OR s.report_deadline>?) LIMIT 1`,
        [user.id, user.companyId, user.id, user.id, user.id, wall],
      );
      if (busy || live)
        liveFail('本人仍在直播或日常工作中，请先结束，不能重复计时');
      await em.query(
        "UPDATE live_daily_work SET status='working',actual_start=?,hourly_rate_cents=?,updated_by=? WHERE company_id=? AND id=?",
        [wall, person.hourly_rate, user.id, user.companyId, id],
      );
      await audit(em, user, id, 'live.daily.start', {
        actualStart: wall,
        hourlyRateCents: Number(person.hourly_rate),
      });
      return { ok: true };
    });
  }
  async finish(user: AuthUser, id: number, report: string) {
    requireUse(await loadLiveAccess(this.ds.manager, user));
    if (!report.trim()) liveFail('请填写完成的工作内容', 400);
    return this.ds.transaction(async (em) => {
      const r = await dailyRow(em, user.companyId, id, true),
        now = liveClock.now();
      if (Number(r.user_id) !== user.id)
        liveFail('只能结束本人的日常工作', 403);
      if (r.status !== 'working') liveFail('本次日常工作不在计时中');
      const minutes = Math.max(
          0,
          Math.round((+now - +liveFromText(r.actual_start_text)!) / 60000),
        ),
        amount = Math.round((Number(r.hourly_rate_cents) * minutes) / 60);
      await dailyOverdue(em, { ...r, actual_end: wallNow(now) }, now);
      await em.query(
        "UPDATE live_daily_work SET status='pending',actual_end=?,minutes=?,amount_cents=?,report=?,updated_by=? WHERE company_id=? AND id=?",
        [
          wallNow(now),
          minutes,
          amount,
          report.trim(),
          user.id,
          user.companyId,
          id,
        ],
      );
      await audit(em, user, id, 'live.daily.finish', {
        actualEnd: wallNow(now),
        minutes,
        amountCents: amount,
      });
      return { ok: true };
    });
  }
  async updateReport(user: AuthUser, id: number, report: string) {
    requireUse(await loadLiveAccess(this.ds.manager, user));
    if (!report.trim()) liveFail('请填写完成的工作内容', 400);
    return this.ds.transaction(async (em) => {
      const r = await dailyRow(em, user.companyId, id, true);
      if (Number(r.user_id) !== user.id) liveFail('只能修改本人工作报告', 403);
      if (!['pending', 'returned'].includes(r.status))
        liveFail('只有待提交或退回的报告可以修改');
      await em.query(
        'UPDATE live_daily_work SET report=?,updated_by=? WHERE company_id=? AND id=?',
        [report.trim(), user.id, user.companyId, id],
      );
      await audit(em, user, id, 'live.daily.report', { report });
      return { ok: true };
    });
  }
  async submit(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.ds.manager, user);
    requireUse(a);
    const r = await dailyRow(this.ds.manager, user.companyId, id);
    if (Number(r.user_id) !== user.id && !a.canManage)
      liveFail('只能提交本人的日常工作', 403);
    if (r.status === 'returned' && r.flow_run_id) {
      const [run] = await this.ds.query(
        'SELECT revision FROM flow_runs WHERE company_id=? AND id=?',
        [user.companyId, r.flow_run_id],
      );
      if (run)
        return {
          runId: (
            await this.flow.resubmit(user, Number(r.flow_run_id), {
              revision: Number(run.revision),
              payload: { workId: id },
            })
          ).id,
        };
    }
    return {
      runId: (
        await this.flow.start(
          user,
          'live-daily-work-review',
          { workId: id },
          undefined,
          { internal: true },
        )
      ).id,
    };
  }
  async scan() {
    const rows: Row[] = await this.ds.query(
      `${dailySelect} WHERE w.overdue_notified_at IS NULL AND w.actual_start IS NOT NULL AND ((w.status='working' AND w.planned_end<DATE_SUB(?,INTERVAL 1 HOUR)) OR w.actual_end>DATE_ADD(w.planned_end,INTERVAL 1 HOUR)) ORDER BY w.id LIMIT 200`,
      [wallNow(liveClock.now())],
    );
    for (const row of rows)
      await this.ds.transaction(async (em) => {
        const r = await dailyRow(
          em,
          Number(row.company_id),
          Number(row.id),
          true,
        );
        await dailyOverdue(
          em,
          r,
          r.actual_end_text
            ? liveFromText(r.actual_end_text)!
            : liveClock.now(),
        );
      });
    return rows.length;
  }
}
