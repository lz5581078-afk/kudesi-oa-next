import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  LIVE_MAX_SCHEDULE_MINUTES, LIVE_SCHEDULE_STATUS, liveAddDays, liveCanScheduleDay, liveFromText, liveGroupRooms, liveIsDay, liveMinutesOf, liveToday,
} from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { Notification } from '../entities';
import { LiveAccess, liveDouyinAccounts, liveDouyinStores, liveEmployees, livePeople, liveRoomList, loadLiveAccess, requireManage, requireUse, requireView } from './live-access';
import { Row, SESSION_SELECT, idOf, liveClock, liveFail, lockCompany, text, wallNow } from './live-core';

export interface ScheduleInput {
  date: string; roomId: number; startTime: string; endTime: string; anchorId: number; controlId?: number | null; operatorId?: number | null;
  douyinAccountId: number; storeId?: number | null; note?: string;
}

const SCHEDULE_SELECT = `SELECT s.*, DATE_FORMAT(s.schedule_date,'%Y-%m-%d') schedule_day, DATE_FORMAT(s.start_at,'%Y-%m-%d %H:%i:%s') start_text, DATE_FORMAT(s.end_at,'%Y-%m-%d %H:%i:%s') end_text,
    a.name anchor_name, c.name control_name, o.name operator_name
    FROM live_schedules s JOIN users a ON a.id = s.anchor_user_id AND a.company_id = s.company_id
    LEFT JOIN users c ON c.id = s.control_user_id AND c.company_id = s.company_id LEFT JOIN users o ON o.id = s.operator_user_id AND o.company_id = s.company_id`;

export function serializeSchedule(s: Row) {
  return {
    id: Number(s.id), roomId: Number(s.room_id), roomName: s.room_name, date: s.schedule_day, start: s.start_text, end: s.end_text,
    startTime: String(s.start_text).slice(11, 16), endTime: String(s.end_text).slice(11, 16), status: s.status, statusLabel: LIVE_SCHEDULE_STATUS[s.status] ?? s.status,
    anchor: { id: Number(s.anchor_user_id), name: s.anchor_name }, control: s.control_user_id ? { id: Number(s.control_user_id), name: s.control_name } : null,
    operator: s.operator_user_id ? { id: Number(s.operator_user_id), name: s.operator_name } : null,
    douyinAccount: { id: Number(s.douyin_account_id), name: s.douyin_account_name }, store: s.store_id ? { id: Number(s.store_id), name: s.store_name } : null,
    sessionId: s.session_id ? Number(s.session_id) : null, note: s.note, cancelReason: s.cancel_reason,
  };
}

/** 排场：今天及未来 7 天，同一房间时间段不重叠，同一主播不能同时在两个房间。 */
@Injectable()
export class LiveScheduleService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}
  private get em() { return this.ds.manager; }

  async access(user: AuthUser) { return loadLiveAccess(this.em, user); }

  async options(user: AuthUser) {
    const a = await this.access(user); requireUse(a);
    const c = user.companyId;
    const [rooms, staff, everyone, accounts, stores, liveRows] = await Promise.all([
      liveRoomList(this.em, c), livePeople(this.em, c), liveEmployees(this.em, c), liveDouyinAccounts(this.em, c), liveDouyinStores(this.em, c),
      this.em.query("SELECT room_id, anchor_user_id FROM live_sessions WHERE company_id = ? AND status = 'live'", [c]) as Promise<Row[]>,
    ]);
    const busyRooms = new Set(liveRows.map((r) => Number(r.room_id))), busyAnchors = new Set(liveRows.map((r) => Number(r.anchor_user_id)));
    return {
      rooms: rooms.map((r) => ({ ...r, live: busyRooms.has(r.id) })),
      anchors: staff.anchors.map((p) => ({ ...p, live: busyAnchors.has(p.id) })), controls: staff.controls, operators: everyone,
      douyinAccounts: accounts.map(({ id, name, detail }) => ({ id, name, detail })),
      stores: stores.map(({ id, name, detail, jstShopId }) => ({ id, name, detail, hasJstShop: Boolean(jstShopId) })),
    };
  }

  // ---------- 排场校验 ----------
  private async validate(em: EntityManager, a: LiveAccess, input: ScheduleInput, excludeId: number | null) {
    const day = String(input.date || '');
    if (!liveCanScheduleDay(day, liveClock.now())) liveFail('只能给今天及未来7天排场', 400);
    const startMinutes = liveMinutesOf(input.startTime), endMinutes = liveMinutesOf(input.endTime);
    if (startMinutes === null || endMinutes === null) liveFail('请填写开始和结束时间（时:分）', 400);
    const endDay = (endMinutes as number) <= (startMinutes as number) ? liveAddDays(day, 1) : day;
    const startAt = `${day} ${input.startTime}:00`, endAt = `${endDay} ${input.endTime}:00`;
    const duration = (liveFromText(endAt)!.getTime() - liveFromText(startAt)!.getTime()) / 60000;
    if (duration > LIVE_MAX_SCHEDULE_MINUTES) liveFail('单场时长不能超过 16 小时', 400);
    const roomId = idOf(input.roomId), anchorId = idOf(input.anchorId), accountId = idOf(input.douyinAccountId);
    if (!roomId || !anchorId || !accountId) liveFail('请选择直播间、主播和抖音号', 400);
    const room = (await liveRoomList(em, a.companyId)).find((r) => r.id === roomId);
    if (!room) liveFail('所选房间不是「西走廊办公室」下名称含「直播间」的启用房间', 400);
    const { anchors, controls } = await livePeople(em, a.companyId);
    if (!anchors.some((p) => p.id === anchorId)) liveFail('所选人员不是主播岗位，请在「部门与岗位」把主播岗位的岗位类型设为「直播主播」', 400);
    const controlId = input.controlId ? idOf(input.controlId) : null;
    if (input.controlId && (!controlId || !controls.some((p) => p.id === controlId))) liveFail('所选人员不是中控岗位', 400);
    const operatorId = input.operatorId ? idOf(input.operatorId) : null;
    if (input.operatorId && !(await liveEmployees(em, a.companyId)).some((p) => p.id === operatorId)) liveFail('所选运营人员不存在或已停用', 400);
    const account = (await liveDouyinAccounts(em, a.companyId)).find((x) => x.id === accountId);
    if (!account) liveFail('所选抖音号不存在、已停用或不是抖音平台账号', 400);
    const storeId = input.storeId ? idOf(input.storeId) : null;
    const store = storeId ? (await liveDouyinStores(em, a.companyId)).find((x) => x.id === storeId) : null;
    if (input.storeId && !store) liveFail('所选店铺不存在、已注销或不是抖音店铺', 400);
    // 同一房间时间段不能重叠；同一主播不能同时在两个房间（相邻首尾相接不算重叠）
    const overlaps: Row[] = await em.query(
      `SELECT s.id, s.room_id, s.anchor_user_id, s.room_name, DATE_FORMAT(s.start_at,'%H:%i') st, DATE_FORMAT(s.end_at,'%H:%i') et, e.name anchor_name
         FROM live_schedules s JOIN users e ON e.id = s.anchor_user_id AND e.company_id = s.company_id
        WHERE s.company_id = ? AND s.status IN ('scheduled','live') AND s.start_at < ? AND s.end_at > ? AND (s.room_id = ? OR s.anchor_user_id = ?)${excludeId ? ' AND s.id <> ?' : ''} FOR UPDATE`,
      [a.companyId, endAt, startAt, roomId, anchorId, ...(excludeId ? [excludeId] : [])]);
    const roomClash = overlaps.find((r) => Number(r.room_id) === roomId);
    if (roomClash) liveFail(`该直播间 ${roomClash.st}–${roomClash.et} 已有排场（主播 ${roomClash.anchor_name}），时间段不能重叠`);
    const anchorClash = overlaps.find((r) => Number(r.anchor_user_id) === anchorId);
    if (anchorClash) liveFail(`${anchorClash.anchor_name} 在 ${anchorClash.st}–${anchorClash.et} 已排在 ${anchorClash.room_name}，同一主播不能同时在两个房间`);
    return { day, startAt, endAt, room: room!, anchorId: anchorId!, controlId, operatorId, account: account!, store: store ?? null, note: text(input.note) || null };
  }

  private async notify(em: EntityManager, companyId: number, ids: Array<number | null | undefined>, title: string, body: string) {
    for (const uid of [...new Set(ids.filter((v): v is number => !!v).map(Number))]) {
      await em.insert(Notification, { companyId, userId: uid, kind: 'live_schedule', title: title.slice(0, 200), body: body.slice(0, 500), link: '/features/live-desk' });
    }
  }
  private summary(r: Row) { return `${r.start_text.slice(0, 16)} 至 ${r.end_text.slice(0, 16)} · ${r.room_name} · 主播 ${r.anchor_name}${r.control_name ? `，中控 ${r.control_name}` : ''}${r.operator_name ? `，运营 ${r.operator_name}` : ''}`; }

  async list(user: AuthUser, q: { from?: string; to?: string }) {
    const a = await this.access(user); requireUse(a);
    const today = liveToday(liveClock.now());
    const from = liveIsDay(q.from) ? (q.from as string) : today, to = liveIsDay(q.to) ? (q.to as string) : liveAddDays(today, 7);
    const own = !a.canView;
    const rows: Row[] = await this.em.query(
      `${SCHEDULE_SELECT} WHERE s.company_id = ? AND s.schedule_date BETWEEN ? AND ?${own ? ' AND (s.anchor_user_id = ? OR s.control_user_id = ? OR s.operator_user_id = ?)' : ''} ORDER BY s.schedule_date, s.start_at, s.id`,
      [a.companyId, from, to, ...(own ? [a.userId, a.userId, a.userId] : [])]);
    return { from, to, rows: rows.map(serializeSchedule), canManage: a.canManage };
  }

  async create(user: AuthUser, input: ScheduleInput) {
    const a = await this.access(user); requireManage(a);
    return this.ds.transaction(async (em) => {
      await lockCompany(em, a.companyId);
      const v = await this.validate(em, a, input, null);
      const res = await em.query(
        `INSERT INTO live_schedules (company_id, room_id, room_name, schedule_date, start_at, end_at, anchor_user_id, control_user_id, operator_user_id, douyin_account_id, douyin_account_name, store_id, store_name, status, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',?,?)`,
        [a.companyId, v.room.id, v.room.name, v.day, v.startAt, v.endAt, v.anchorId, v.controlId, v.operatorId, v.account.id, v.account.name, v.store?.id ?? null, v.store?.name ?? null, v.note, a.userId]);
      const id = Number(res.insertId);
      const [row] = await em.query(`${SCHEDULE_SELECT} WHERE s.company_id = ? AND s.id = ?`, [a.companyId, id]);
      await this.notify(em, a.companyId, [v.anchorId, v.controlId, v.operatorId], '新排班', this.summary(row));
      return { id };
    });
  }

  async update(user: AuthUser, id: number, input: ScheduleInput) {
    const a = await this.access(user); requireManage(a);
    await this.ds.transaction(async (em) => {
      await lockCompany(em, a.companyId);
      const [old] = await em.query(`${SCHEDULE_SELECT} WHERE s.company_id = ? AND s.id = ? FOR UPDATE OF s`, [a.companyId, id]);
      if (!old) liveFail('排场不存在', 404);
      if (old.status !== 'scheduled') liveFail('已上播、已结束或已取消的排场不能修改');
      const v = await this.validate(em, a, input, id);
      await em.query(
        `UPDATE live_schedules SET room_id = ?, room_name = ?, schedule_date = ?, start_at = ?, end_at = ?, anchor_user_id = ?, control_user_id = ?, operator_user_id = ?,
           douyin_account_id = ?, douyin_account_name = ?, store_id = ?, store_name = ?, note = ?, updated_by = ?, notification_version = notification_version + 1 WHERE company_id = ? AND id = ?`,
        [v.room.id, v.room.name, v.day, v.startAt, v.endAt, v.anchorId, v.controlId, v.operatorId, v.account.id, v.account.name, v.store?.id ?? null, v.store?.name ?? null, v.note, a.userId, a.companyId, id]);
      const [row] = await em.query(`${SCHEDULE_SELECT} WHERE s.company_id = ? AND s.id = ?`, [a.companyId, id]);
      const now = new Set([v.anchorId, v.controlId, v.operatorId].filter(Boolean) as number[]);
      await this.notify(em, a.companyId, [...now], '排班已调整', this.summary(row));
      // 被移出排场的人：通知“已不再参与”
      const removed = [old.anchor_user_id, old.control_user_id, old.operator_user_id].filter((x) => x && !now.has(Number(x))).map(Number);
      await this.notify(em, a.companyId, removed, '原排班已调整，您已不再参与', `${old.start_text.slice(0, 16)} 至 ${old.end_text.slice(0, 16)} · ${old.room_name}`);
    });
    return { ok: true };
  }

  async cancel(user: AuthUser, id: number, reason: string) {
    const a = await this.access(user); requireManage(a);
    const why = text(reason);
    if (!why) liveFail('请填写取消排场的原因', 400);
    await this.ds.transaction(async (em) => {
      await lockCompany(em, a.companyId);
      const [row] = await em.query(`${SCHEDULE_SELECT} WHERE s.company_id = ? AND s.id = ? FOR UPDATE OF s`, [a.companyId, id]);
      if (!row) liveFail('排场不存在', 404);
      if (row.status !== 'scheduled') liveFail('已上播或已结束的排场不能取消');
      await em.query("UPDATE live_schedules SET status = 'cancelled', cancel_reason = ?, updated_by = ?, notification_version = notification_version + 1 WHERE company_id = ? AND id = ?", [why, a.userId, a.companyId, id]);
      await this.notify(em, a.companyId, [row.anchor_user_id, row.control_user_id, row.operator_user_id], '排班已取消', `${this.summary(row)}。原因：${why}`);
    });
    return { ok: true };
  }

  /** 开播前 30 分钟提醒（定时扫描）：每个排场版本只提醒一次；已取消、已上播的不提醒。 */
  async scanReminders(now: Date = liveClock.now()): Promise<number> {
    const from = wallNow(now), to = wallNow(new Date(now.getTime() + 30 * 60000));
    const rows: Row[] = await this.em.query(
      `${SCHEDULE_SELECT} WHERE s.status = 'scheduled' AND s.start_at > ? AND s.start_at <= ? AND s.reminder_version < s.notification_version ORDER BY s.start_at`, [from, to]);
    for (const r of rows) {
      await this.ds.transaction(async (em) => {
        const res = await em.query('UPDATE live_schedules SET reminder_version = notification_version WHERE company_id = ? AND id = ? AND reminder_version < notification_version', [r.company_id, r.id]);
        if (!res.affectedRows) return;
        await this.notify(em, Number(r.company_id), [r.anchor_user_id, r.control_user_id, r.operator_user_id], '开播前30分钟提醒', this.summary(r));
      });
    }
    return rows.length;
  }

  // ---------- 全览 ----------
  async overview(user: AuthUser, date?: string) {
    const a = await this.access(user); requireView(a);
    const now = liveClock.now(), nowText = wallNow(now);
    const day = liveIsDay(date) ? (date as string) : liveToday(now);
    const [rooms, schedules, sessions]: [Awaited<ReturnType<typeof liveRoomList>>, Row[], Row[]] = await Promise.all([
      liveRoomList(this.em, a.companyId),
      this.em.query(`${SCHEDULE_SELECT} WHERE s.company_id = ? AND s.schedule_date = ? AND s.status <> 'cancelled' ORDER BY s.start_at`, [a.companyId, day]),
      this.em.query(`${SESSION_SELECT} WHERE s.company_id = ? AND (s.session_date = ? OR s.status = 'live') ORDER BY s.start_at`, [a.companyId, day]),
    ]);
    const tiles = rooms.map((room) => {
      const roomSessions = sessions.filter((s) => Number(s.room_id) === room.id);
      const live = roomSessions.find((s) => s.status === 'live') ?? null;
      const items = schedules.filter((s) => Number(s.room_id) === room.id).map((s) => {
        const session = roomSessions.find((x) => Number(x.schedule_id) === Number(s.id));
        const state = session ? (session.status === 'live' ? 'live' : 'done') : s.end_text <= nowText ? 'missed' : s.start_text <= nowText ? 'due' : 'upcoming';
        return { kind: 'schedule', id: Number(s.id), start: s.start_text, end: session?.end_text || s.end_text, plannedEnd: s.end_text, anchorName: s.anchor_name, controlName: s.control_name, operatorName: s.operator_name, douyinName: s.douyin_account_name, state, sessionId: session ? Number(session.id) : null };
      });
      for (const s of roomSessions.filter((x) => !x.schedule_id && x.session_day === day)) {
        items.push({ kind: 'adhoc', id: Number(s.id), start: s.start_text, end: s.end_text, plannedEnd: s.end_text, anchorName: s.anchor_name, controlName: s.control_name, operatorName: s.operator_name, douyinName: s.douyin_account_name, state: s.status === 'live' ? 'live' : 'done', sessionId: Number(s.id) });
      }
      items.sort((x, y) => String(x.start).localeCompare(String(y.start)));
      const upcoming = items.find((i) => ['upcoming', 'due'].includes(i.state)) ?? null;
      const status = live ? 'live' : day === liveToday(now) && items.some((i) => i.state === 'done') && !upcoming ? 'finished' : 'idle';
      const liveView = live ? {
        id: Number(live.id), startAt: live.start_text, plannedEnd: live.schedule_end, anchor: { id: Number(live.anchor_user_id), name: live.anchor_name },
        control: live.control_user_id ? { id: Number(live.control_user_id), name: live.control_name } : null, operator: live.operator_user_id ? { id: Number(live.operator_user_id), name: live.operator_name } : null,
        douyinAccount: { id: Number(live.douyin_account_id), name: live.douyin_account_name },
      } : null;
      return { ...room, status, statusLabel: ({ live: '正在直播', finished: '今日已结束', idle: '未开播' } as Record<string, string>)[status], live: liveView, next: live ? null : upcoming, timeline: items };
    });
    return {
      date: day, now: nowText, groups: liveGroupRooms(tiles), corridorFound: rooms.length > 0,
      totals: { rooms: tiles.length, live: tiles.filter((t) => t.status === 'live').length, scheduled: schedules.length, pendingReview: sessions.filter((s) => s.status === 'submitted').length },
    };
  }

  /** 点开一个直播间：当天的排场和实际直播。 */
  async roomDay(user: AuthUser, roomId: number, date?: string) {
    const a = await this.access(user); requireView(a);
    const day = liveIsDay(date) ? (date as string) : liveToday(liveClock.now());
    const room = (await liveRoomList(this.em, a.companyId)).find((r) => r.id === roomId);
    if (!room) liveFail('直播间不存在或已停用', 404);
    const [schedules, sessions]: [Row[], Row[]] = await Promise.all([
      this.em.query(`${SCHEDULE_SELECT} WHERE s.company_id = ? AND s.room_id = ? AND s.schedule_date = ? ORDER BY s.start_at`, [a.companyId, roomId, day]),
      this.em.query(`${SESSION_SELECT} WHERE s.company_id = ? AND s.room_id = ? AND (s.session_date = ? OR s.status = 'live') ORDER BY s.start_at`, [a.companyId, roomId, day]),
    ]);
    const reports: Row[] = sessions.length ? await this.em.query(`SELECT session_id, role, sales_cents FROM live_session_reports WHERE company_id = ? AND session_id IN (${sessions.map(() => '?').join(',')})`, [a.companyId, ...sessions.map((s) => s.id)]) : [];
    return {
      room, date: day, schedules: schedules.map(serializeSchedule),
      sessions: sessions.map((s) => {
        const mine = reports.filter((r) => Number(r.session_id) === Number(s.id));
        return {
          id: Number(s.id), scheduleId: s.schedule_id ? Number(s.schedule_id) : null, status: s.status, startAt: s.start_text, endAt: s.end_text, anchor: { id: Number(s.anchor_user_id), name: s.anchor_name },
          control: s.control_user_id ? { id: Number(s.control_user_id), name: s.control_name } : null, douyinAccount: { id: Number(s.douyin_account_id), name: s.douyin_account_name },
          anchorSalesCents: mine.find((r) => r.role === 'anchor') ? Number(mine.find((r) => r.role === 'anchor')!.sales_cents) : null,
          controlSalesCents: mine.find((r) => r.role === 'control') ? Number(mine.find((r) => r.role === 'control')!.sales_cents) : null,
          finalSalesCents: s.final_sales_cents === null ? null : Number(s.final_sales_cents),
        };
      }),
    };
  }
}
