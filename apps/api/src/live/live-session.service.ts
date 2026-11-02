import { createHash, randomBytes } from 'node:crypto';
import { REPORT_WINDOW_MS, reportsLocked, scheduleFingerprint, primaryReport } from './live-checkin-core';
import { captureOrders, persistCapture } from './live-order-capture';
import { liveStartNotification, liveStartRecipients } from './live-start-notification';
import { liveHandover } from './live-notification-events';
import { channelsOf, linesOf, validateChannels, assertAccountTime, checkStoreLines, persistStoreLines, channelStores } from './live-platforms';
import { LiveChannelInput, LiveStoreLine, livePlatformCommissions } from '@kudesi/shared';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  type LiveProductEntry, LIVE_ROLE_LABEL, LIVE_SESSION_STATUS, LIVE_START_EARLY_MS, LiveRuleError, liveAddDays, liveCanSeeSession, liveComputeCommission, liveFilterPreview, liveFromText, liveYuanToCents, liveIsDay, liveIsMonth,
  liveMonthBounds, liveReportRoleFor, liveToText, liveToday, liveVersionFor,
} from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { FlowService } from '../flow/flow.service';
import { commissionOnlyControl, LiveAccess, liveDouyinAccounts, liveDouyinStores, resolveLiveProducts, liveRoomList, livePeople, loadLiveAccess, requireUse } from './live-access';
import { Row, SESSION_SELECT, closedDay, idOf, liveClock, liveFail, lockCompany, num, numOrNull, reportsOf, ruleVersions, sessionRow, text, wallNow } from './live-core';
import { LiveOrderSource } from './live-order-source';
import { ReviewForm, checkSubmittable, previewApproval } from './live-review';
import { serializeSchedule } from './live-schedule.service';

export interface StartInput {
  role?:'anchor'|'control'|'operator'; actualCheckin?: boolean; sessionId?: number; confirmDetails?: boolean; confirmEarly?: boolean; scheduleFingerprint?: string;
  scheduleId?: number | null; roomId?: number | null; anchorId?: number | null; controlId?: number | null; operatorId?: number | null;
  channels?: LiveChannelInput[]; douyinAccountId?: number | null; storeId?: number | null; productIds?: number[]; productEntries?: LiveProductEntry[]; startAt?: string | null;
}
export interface ReportInput { storeLines?: LiveStoreLine[]; role?: string; endAt: string; salesCents: number; adSpendCents?: number | null; orderIds?: string[]; note?: string }
export interface SessionQuery { from?: string; to?: string; roomId?: number; anchorId?: number; controlId?: number; status?: string; page?: number; pageSize?: number; reviewOnly?: boolean }

const ACTIVE = ['live', 'pending_report', 'returned', 'submitted'];
const SKEW_MS = 5 * 60000;
const REVIEWER_SQL = 'EXISTS (SELECT 1 FROM flow_steps fs WHERE fs.run_id = s.flow_run_id AND JSON_CONTAINS(fs.recipients, CAST(? AS JSON)))';

export function serializeSession(s: Row) {
  return {
    checkinMode: !!s.checkin_mode, reportDeadline: liveToText(s.report_deadline), reportsLocked: reportsLocked(s, liveClock.now()), autoSubmitError: s.auto_submit_error ?? null, ordersCaptureStatus: s.orders_capture_status, ordersCaptureError: s.orders_capture_error ?? null,
    channels: channelsOf(s),
    id: Number(s.id), scheduleId: s.schedule_id ? Number(s.schedule_id) : null, roomId: Number(s.room_id), roomName: s.room_name, date: s.session_day, startAt: s.start_text, endAt: s.end_text ?? null,
    plannedEnd: s.schedule_end ?? null, status: s.status, statusLabel: LIVE_SESSION_STATUS[s.status] ?? s.status,
    anchor: { id: Number(s.anchor_user_id), name: s.anchor_name }, control: s.control_user_id ? { id: Number(s.control_user_id), name: s.control_name } : null,
    operator: s.operator_user_id ? { id: Number(s.operator_user_id), name: s.operator_name } : null,
    douyinAccount: { id: Number(s.douyin_account_id), name: s.douyin_account_name }, store: s.store_id ? { id: Number(s.store_id), name: s.store_name } : null,
    finalSalesCents: numOrNull(s.final_sales_cents), finalSalesSource: s.final_sales_source ?? null, finalSalesReason: s.final_sales_reason ?? null,
    returnReason: s.return_reason ?? null, flowRunId: s.flow_run_id ? Number(s.flow_run_id) : null, submittedAt: s.submitted_text ?? null, approvedAt: s.approved_text ?? null,
    reportSource:s.report_source??'normal',manualReason:s.manual_reason??null,manualActorId:s.manual_actor_id?Number(s.manual_actor_id):null,
    approverName: s.approver_name ?? null, revision: Number(s.revision),
  };
}

/** 场次：上播、报下播、提交审核、列表与详情、我的直播工作台。 */
@Injectable()
export class LiveSessionService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly orders: LiveOrderSource) {}
  private get em() { return this.ds.manager; }

  // ---------- 通用 ----------
  private isParticipant(s: Row, uid: number) { return [s.anchor_user_id, s.control_user_id, s.operator_user_id, s.started_by].some((v) => v !== null && v !== undefined && Number(v) === uid); }
  private async isReviewer(em: EntityManager, s: Row, uid: number) {
    if (!s.flow_run_id) return false;
    const [r] = await em.query('SELECT COUNT(*) n FROM flow_steps WHERE run_id = ? AND JSON_CONTAINS(recipients, CAST(? AS JSON))', [s.flow_run_id, String(uid)]);
    return Number(r.n) > 0;
  }
  private people(s: Row) { return { anchorId: Number(s.anchor_user_id), controlId: s.control_user_id ? Number(s.control_user_id) : null, operatorId: s.operator_user_id ? Number(s.operator_user_id) : null, startedBy: s.started_by ? Number(s.started_by) : null }; }
  private async visible(em: EntityManager, a: LiveAccess, s: Row) {
    return liveCanSeeSession(a.canView || a.canViewAll, a.userId, this.people(s)) || (await this.isReviewer(em, s, a.userId));
  }
  private parseTime(value: unknown, label: string): string {
    const t = liveToText(value);
    if (!t) liveFail(`${label}格式不正确（年-月-日 时:分）`, 400);
    return t as string;
  }

  async requireTrialIssuer(companyId:number, userId:number, em=this.em) {
    const staff=await liveStartRecipients(em,companyId,new Set(['人事部','人事综合部','人力资源部']));
    if(!staff.includes(userId)) liveFail('只有人事人员可以签发临时主播开播码',403);
  }

  async issueTrial(user:AuthUser, form:StartInput) {
    await this.requireTrialIssuer(user.companyId,user.id);
    const input:StartInput={roomId:form.roomId,anchorId:form.anchorId,controlId:form.controlId,operatorId:form.operatorId,channels:form.channels,productEntries:form.productEntries};
    const staff=await livePeople(this.em,user.companyId);
    if(!staff.anchors.some(p=>p.id===input.anchorId && p.trial)) liveFail('请选择在职试播主播',400);
    if(!input.controlId || !staff.controls.some(p=>p.id===input.controlId)) liveFail('请指定本场中控，供本人扫码加入',400);
    if(!(await liveRoomList(this.em,user.companyId)).some(r=>r.id===input.roomId)) liveFail('请选择直播间',400);
    await validateChannels(this.em,user.companyId,input.channels??[]);
    await resolveLiveProducts(this.em,user.companyId,input,true);
    const token=randomBytes(24).toString('base64url');
    await this.em.query('INSERT INTO live_trial_tickets(token_hash,company_id,issuer_id,payload,expires_at) VALUES(?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 20 MINUTE))',
      [createHash('sha256').update(token).digest('hex'),user.companyId,user.id,JSON.stringify(input)]);
    return {token};
  }

  async redeemTrial(token:string) {
    const hash=createHash('sha256').update(token).digest('hex');
    return this.ds.transaction(async em=>{
      const [ticket]=await em.query('SELECT * FROM live_trial_tickets WHERE token_hash=? AND expires_at>UTC_TIMESTAMP() AND session_id IS NULL FOR UPDATE',[hash]);
      if(!ticket) liveFail('开播码已使用或已过期，请联系人事',400);
      const companyId=Number(ticket.company_id);
      await lockCompany(em,companyId);
      await this.requireTrialIssuer(companyId,Number(ticket.issuer_id),em);
      const input:StartInput=typeof ticket.payload==='string'?JSON.parse(ticket.payload):ticket.payload;
      const user:AuthUser={id:Number(input.anchorId),companyId,name:'试播主播',permissions:{isCompanyAdmin:false,allow:[],deny:[]}};
      const access=await loadLiveAccess(em,user);
      const result=await this.startLocked(em,user,access,{...input,actualCheckin:true},true);
      await em.query('UPDATE live_trial_tickets SET session_id=? WHERE token_hash=?',[result.id,hash]);
      return result;
    });
  }

  async start(user: AuthUser, input: StartInput) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    return this.ds.transaction(async em=>{
      await lockCompany(em,a.companyId);
      return this.startLocked(em,user,a,input,false);
    });
  }

  private async startLocked(em:EntityManager,user:AuthUser,a:LiveAccess,input:StartInput,trial:boolean) {
      const now = liveClock.now();
      if(input.actualCheckin){
        const [busy]=await em.query("SELECT c.session_id,c.role FROM live_session_checkins c JOIN live_sessions s ON s.company_id=c.company_id AND s.id=c.session_id WHERE c.company_id=? AND c.user_id=? AND c.end_at IS NULL AND s.status IN ('live','pending_report') AND s.report_locked_at IS NULL AND (s.report_deadline IS NULL OR s.report_deadline>?) LIMIT 1",[a.companyId,a.userId,wallNow(now)]);
        if(busy&&Number(busy.session_id)!==input.sessionId&&(!input.scheduleId||!(await em.query('SELECT id FROM live_schedules WHERE company_id=? AND id=? AND session_id=?',[a.companyId,input.scheduleId,busy.session_id])).length))liveFail('本人还有未下播场次，请先下播',409);
        if(busy&&input.role&&busy.role!==input.role)liveFail('本场已按其他身份上播，不能切换身份',409);
        if(input.role==='operator'){
          if(!a.isOperations||!input.sessionId)liveFail('只有运营岗位可选择本场运营身份',403);
          const s=await sessionRow(em,a.companyId,input.sessionId,true);
          if(!s.checkin_mode||s.status!=='live'||s.first_reported_at)liveFail('本场已结束或有人报下播，不能加入',409);
          if(Number(s.anchor_user_id)===a.userId||Number(s.control_user_id)===a.userId)liveFail('主播或中控不能同时选择运营身份',403);
          const [control]=await em.query("SELECT id FROM live_session_checkins WHERE company_id=? AND session_id=? AND role='control' AND user_id=? AND end_at IS NULL",[a.companyId,s.id,s.control_user_id]);
          if(!control)liveFail('本场有中控上播时才可选择运营身份',409);
          if(s.operator_user_id&&Number(s.operator_user_id)!==a.userId)liveFail('本场已安排其他运营，请选择本人场次',409);
          if(!input.confirmDetails)liveFail('请先核对本场信息后确认运营上播',400);
          await em.query('UPDATE live_sessions SET operator_user_id=?,revision=revision+1 WHERE company_id=? AND id=?',[a.userId,a.companyId,s.id]);
          await em.query("INSERT IGNORE INTO live_session_checkins(company_id,session_id,user_id,role,start_at,confirmation_json) VALUES(?,?,?,'operator',?,?)",[a.companyId,s.id,a.userId,wallNow(now),JSON.stringify({confirmed:true,role:'operator'})]);
          return {id:Number(s.id)};
        }
        if(input.role==='control'&&!a.isControl||input.role==='anchor'&&!a.isAnchor)liveFail('没有所选上播身份',403);
      }
      if (input.actualCheckin && input.sessionId) {
        const existing = await sessionRow(em,a.companyId,input.sessionId,true);
        if(input.role==='control'&&!existing.control_user_id&&Number(existing.anchor_user_id)!==a.userId){
          if(!a.isControl||!input.confirmDetails)liveFail('请以本人中控身份核对场次',403);
          if(existing.status!=='live'||existing.first_reported_at)liveFail('本场不能再加入中控',409);
          await em.query('UPDATE live_sessions SET control_user_id=?,operator_user_id=IF(operator_user_id=?,NULL,operator_user_id) WHERE company_id=? AND id=?',[a.userId,a.userId,a.companyId,existing.id]);existing.control_user_id=a.userId;if(Number(existing.operator_user_id)===a.userId)existing.operator_user_id=null;
        }
        const role = Number(existing.anchor_user_id)===a.userId?'anchor':Number(existing.control_user_id)===a.userId?'control':null;
        if(input.role&&role!==input.role)liveFail('所选身份与本场人员不符',403);
        if (!role || !existing.checkin_mode || existing.status!=='live' || existing.first_reported_at) liveFail('只能为本人尚未结束的场次上播',403);
        if(role==='control'&&!input.confirmDetails)liveFail('中控请先核对本场排班、账号、店铺和产品',400);
        const [already]=await em.query('SELECT id FROM live_session_checkins WHERE company_id=? AND session_id=? AND role=? AND user_id=?',[a.companyId,existing.id,role,a.userId]);
        if(already)return {id:Number(existing.id)};
        const before=channelsOf(existing);
        const beforeProducts=await em.query('SELECT code_snapshot,name_snapshot,spec_snapshot FROM live_session_products WHERE company_id=? AND session_id=? ORDER BY sort_order',[a.companyId,existing.id]);
        if(input.channels){
          const corrected=await validateChannels(em,a.companyId,input.channels);
          await assertAccountTime(em,a.companyId,corrected,existing.start_text,existing.schedule_end??null,Number(existing.id),existing.schedule_id?Number(existing.schedule_id):undefined);
          const primary=corrected[0],store=primary.stores[0];
          await em.query('UPDATE live_sessions SET channels_json=?,douyin_account_id=?,douyin_account_name=?,store_id=?,store_name=?,jst_shop_id=? WHERE company_id=? AND id=?',[JSON.stringify(corrected),primary.accountId,corrected.map(c=>c.accountName).join(' / ').slice(0,200),store.id,store.name,store.jstShopId,a.companyId,existing.id]);
        }
        if(input.productEntries!==undefined||input.productIds!==undefined){
          const products=await resolveLiveProducts(em,a.companyId,input,true);
          await em.query('DELETE FROM live_session_products WHERE company_id=? AND session_id=?',[a.companyId,existing.id]);
          for(const [i,p] of products.entries())await em.query('INSERT INTO live_session_products(company_id,session_id,base_code_id,code_snapshot,name_snapshot,spec_snapshot,sort_order) VALUES(?,?,?,?,?,?,?)',[a.companyId,existing.id,p.id,p.code.slice(0,100),(p.name||p.code).slice(0,200),p.spec.slice(0,300)||null,i]);
        }
        if(role==='control'&&input.operatorId===a.userId)input={...input,operatorId:null};
        if(input.operatorId!==undefined){
          if(input.operatorId){const [op]=await em.query("SELECT id FROM users WHERE company_id=? AND id=? AND status='active'",[a.companyId,input.operatorId]);if(!op||Number(input.operatorId)===Number(existing.anchor_user_id))liveFail('请选择有效运营，运营不能同时是主播',400);}
          await em.query('UPDATE live_sessions SET operator_user_id=? WHERE company_id=? AND id=?',[input.operatorId??null,a.companyId,existing.id]);
        }
        await em.query('INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES(?,?,?,?,?,?)',[a.companyId,a.userId,'live.checkin.confirm','live-session',String(existing.id),JSON.stringify({role,beforeProducts,beforeChannels:before,confirmedChannels:input.channels??null,productEntries:input.productEntries??null,operatorId:input.operatorId??null})]);
        await em.query('UPDATE live_sessions SET revision=revision+1 WHERE company_id=? AND id=?',[a.companyId,existing.id]);
        await em.query('INSERT INTO live_session_checkins (company_id,session_id,user_id,role,start_at,confirmation_json) VALUES (?,?,?,?,?,?)',[a.companyId,existing.id,a.userId,role,wallNow(now),JSON.stringify({confirmed:true,corrected:!!input.channels})]);
        return {id:Number(existing.id)};
      }
      const startAt = !input.actualCheckin && input.startAt ? this.parseTime(input.startAt, '上播时间') : wallNow(now);
      const startDate = liveFromText(startAt)!;
      if (startDate.getTime() > now.getTime() + SKEW_MS) liveFail('上播时间不能晚于现在', 400);
      if (startDate.getTime() < now.getTime() - 12 * 3600000) liveFail('上播时间不能早于 12 小时前，请联系管理员处理', 400);
      const day = startAt.slice(0, 10);
      if (await closedDay(em, a.companyId, day)) liveFail('该日期已进入结算审批或已结算，不能新建场次');
      let sched: Row | null = null;
      let roomId: number | null, anchorId: number | null, controlId: number | null, operatorId: number | null, accountId: number | null, storeId: number | null;
      if (input.scheduleId) {
        const [row] = await em.query('SELECT * FROM live_schedules WHERE company_id = ? AND id = ? FOR UPDATE', [a.companyId, input.scheduleId]);
        if (!row) liveFail('排场不存在', 404);
        sched = row;
        if(input.actualCheckin&&row.session_id){
          const current=await sessionRow(em,a.companyId,Number(row.session_id),true);
          const role=Number(current.anchor_user_id)===a.userId?'anchor':Number(current.control_user_id)===a.userId?'control':null;
          if(current.checkin_mode&&current.status==='live'&&!current.first_reported_at&&role){
            const [clock]=await em.query('SELECT id FROM live_session_checkins WHERE company_id=? AND session_id=? AND role=? AND user_id=?',[a.companyId,current.id,role,a.userId]);
            if(clock)return {id:Number(current.id)};
            liveFail('本场已经开播，请打开实际场次核对信息后确认本人上播',409);
          }
        }
        if (row.status !== 'scheduled' || row.session_id) liveFail('这场排班已上播、已结束或已取消');
        const mine = [row.anchor_user_id, row.control_user_id].some((v) => v && Number(v) === a.userId);
        if (!mine && !a.canManage) liveFail('只有本场排定的主播、中控（或管理人员）可以上播', 403);
        const [st, en] = [liveFromText(wallText(row.start_at))!.getTime(), liveFromText(wallText(row.end_at))!.getTime()];
        if(input.actualCheckin && input.scheduleFingerprint!==scheduleFingerprint(row))liveFail('排班已更新，请重新读取并核对',409);
        if(input.actualCheckin && startDate.getTime()<st && !input.confirmEarly)liveFail('尚未到计划开播时间，请二次确认提前开播',400);
        if (!input.actualCheckin && startDate.getTime() < st - LIVE_START_EARLY_MS) liveFail('距离排场开始还早，开始前 2 小时才可以上播');
        if (startDate.getTime() >= en) liveFail('这场排班已经过了结束时间，不能上播');
        [roomId, anchorId, controlId, operatorId] = [Number(row.room_id), Number(row.anchor_user_id), row.control_user_id ? Number(row.control_user_id) : null, row.operator_user_id ? Number(row.operator_user_id) : null];
        if(input.actualCheckin){
          if ((input.anchorId!=null && input.anchorId!==anchorId) || (input.controlId!==undefined && input.controlId!==controlId))
            liveFail('主播和中控须按排班开播，请重新核对排班',403);
          operatorId=input.operatorId===undefined?operatorId:input.operatorId;
          if(anchorId!==a.userId&&!(a.isControl&&controlId===a.userId))liveFail('只能以本人岗位开播',403);
        }
        accountId = input.douyinAccountId ? idOf(input.douyinAccountId) : Number(row.douyin_account_id);
        storeId = input.storeId ? idOf(input.storeId) : row.store_id ? Number(row.store_id) : null;
      } else {
        if (input.actualCheckin && !trial) liveFail('没有排班不能开播，请联系人事安排',403);
        if (!trial && !a.canManage && !a.isAnchor && !a.isControl) liveFail('只有主播、中控岗位（或管理人员）可以上播', 403);
        roomId = idOf(input.roomId);
        anchorId = idOf(input.anchorId) ?? (a.isAnchor ? a.userId : null);
        controlId = idOf(input.controlId) ?? (input.role==='control' || a.isControl && !a.isAnchor ? a.userId : null);
        if (!anchorId) liveFail('请选择主播', 400);
        if (!a.canManage && anchorId !== a.userId && !(a.isControl && controlId === a.userId)) liveFail('只能以本人的主播或中控身份上播', 403);
        operatorId = idOf(input.operatorId);
        accountId = idOf(input.douyinAccountId); storeId = idOf(input.storeId);
      }
      if (!roomId) liveFail('请选择直播间', 400);
      const room = (await liveRoomList(em, a.companyId)).find((r) => r.id === roomId);
      if (!room) liveFail('所选房间不是启用的直播间', 400);
      const { anchors, controls } = await livePeople(em, a.companyId);
      if (trial && !anchors.some(p=>p.id===anchorId && p.trial)) liveFail('临时主播档案已失效',400);
      if (!anchors.some((p) => p.id === anchorId)) liveFail('所选人员不是主播岗位', 400);
      if (controlId && !controls.some((p) => p.id === controlId)) liveFail('所选人员不是中控岗位', 400);
      if(controlId===anchorId)liveFail('主播和中控须分别由本人打卡，不能是同一人',400);
      if (operatorId) {
        const [op] = await em.query("SELECT id FROM users WHERE company_id = ? AND id = ? AND status = 'active'", [a.companyId, operatorId]);
        if (!op) liveFail('所选运营人员不存在或已停用', 400);
        if (operatorId === anchorId) liveFail('运营人员不能同时是主播', 400);
      }
      const channels = await validateChannels(em, a.companyId, input.channels ?? (sched && channelsOf(sched).length ? channelsOf(sched) : [{ accountId: accountId!, storeIds: storeId ? [storeId] : [] }]));
      const primary = channels[0], account = { id: primary.accountId, name: channels.map(c => c.accountName).join(' / ').slice(0,200) }, store = primary.stores[0];
      const products = await resolveLiveProducts(em, a.companyId, input, true);
      const [busyRoom] = await em.query("SELECT id FROM live_sessions WHERE company_id = ? AND status = 'live' AND room_id = ? LIMIT 1", [a.companyId, roomId]);
      if (busyRoom) liveFail('这个直播间正在直播，请先报下播');
      const [busyAnchor] = await em.query("SELECT id FROM live_sessions WHERE company_id = ? AND status = 'live' AND anchor_user_id = ? LIMIT 1", [a.companyId, anchorId]);
      if (busyAnchor) liveFail('这位主播正在另一场直播中，请先报下播');
      await assertAccountTime(em, a.companyId, channels, startAt, sched ? wallText(sched.end_at) : null, undefined, sched ? Number(sched.id) : undefined);
      const role = a.userId === anchorId ? 'anchor' : a.userId === controlId ? 'control' : 'manager';
      if(input.actualCheckin&&input.role&&role!==input.role)liveFail('请以本人所选身份上播',403);
      if(input.actualCheckin && role==='manager')liveFail('请由主播或中控本人打卡开播',403);
      if(input.actualCheckin && role==='control'&&!input.confirmDetails)liveFail('中控请先核对本场排班、账号、店铺和产品',400);
      const ins = await em.query(
        `INSERT INTO live_sessions (company_id, schedule_id, room_id, room_name, anchor_user_id, control_user_id, operator_user_id, douyin_account_id, douyin_account_name, store_id, store_name, jst_shop_id,
           session_date, start_at, status, started_by, started_role) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'live',?,?)`,
        [a.companyId, sched ? sched.id : null, room!.id, room!.name, anchorId, controlId, operatorId, account!.id, account!.name, store!.id, store!.name, store!.jstShopId, day, startAt, a.userId, role]);
      const id = Number(ins.insertId);
      await em.query('UPDATE live_sessions SET channels_json=? WHERE company_id=? AND id=?', [JSON.stringify(channels),a.companyId,id]);
      if(input.actualCheckin){
        await em.query("UPDATE live_sessions SET checkin_mode=1,orders_capture_status='pending' WHERE company_id=? AND id=?",[a.companyId,id]);
        await em.query('INSERT INTO live_session_checkins (company_id,session_id,user_id,role,start_at,confirmation_json) VALUES (?,?,?,?,?,?)',[a.companyId,id,a.userId,role,startAt,JSON.stringify({scheduleId:input.scheduleId??null,fingerprint:input.scheduleFingerprint??null,confirmed:!!input.confirmDetails,earlyConfirmed:!!input.confirmEarly})]);
      }
      let order = 0;
      for (const p of products) await em.query('INSERT INTO live_session_products (company_id, session_id, base_code_id, code_snapshot, name_snapshot, spec_snapshot, sort_order) VALUES (?,?,?,?,?,?,?)', [a.companyId, id, p.id, p.code.slice(0, 100), (p.name || p.code).slice(0, 200), p.spec.slice(0, 300) || null, order++]);
      if (sched) await em.query("UPDATE live_schedules SET status = 'live', session_id = ?, updated_by = ? WHERE company_id = ? AND id = ?", [id, a.userId, a.companyId, sched.id]);
      if (sched) await liveStartNotification(em, a.companyId, id);
      return { id };
  }

  /** Both room QR and personal desk load this same company-scoped context. */
  async checkinContext(user: AuthUser, roomId?: number) {
    const a=await loadLiveAccess(this.em,user); requireUse(a);
    const rooms=await liveRoomList(this.em,a.companyId);
    if(roomId&&!rooms.some(r=>r.id===roomId))liveFail('直播间不存在',404);
    const desk=await this.workbench(user);
    const rows:Row[]=await this.em.query(`${SESSION_SELECT} WHERE s.company_id=? AND s.checkin_mode=1 AND s.status='live' AND s.first_reported_at IS NULL${roomId?' AND s.room_id=?':''} AND (s.anchor_user_id=? OR s.control_user_id=? OR ?=1) ORDER BY s.start_at DESC LIMIT 100`,[a.companyId,...(roomId?[roomId]:[]),a.userId,a.userId,a.isControl?1:0]);
    const clocks:Row[]=await this.em.query("SELECT session_id,user_id,role FROM live_session_checkins WHERE company_id=? AND end_at IS NULL",[a.companyId]);
    const products:Row[]=rows.length?await this.em.query(`SELECT session_id,base_code_id,code_snapshot,name_snapshot,spec_snapshot FROM live_session_products WHERE company_id=? AND session_id IN (${rows.map(()=>'?').join(',')}) ORDER BY sort_order`,[a.companyId,...rows.map(s=>s.id)]):[];
    const joinable=rows.map(s=>({
      ...serializeSession(s),
      canJoinAnchor:Number(s.anchor_user_id)===a.userId,
      canJoinControl:a.isControl&&Number(s.anchor_user_id)!==a.userId&&(!s.control_user_id||Number(s.control_user_id)===a.userId),
      canJoinOperator:!!a.isOperations&&Number(s.anchor_user_id)!==a.userId&&Number(s.control_user_id)!==a.userId&&(!s.operator_user_id||Number(s.operator_user_id)===a.userId)&&clocks.some(c=>Number(c.session_id)===Number(s.id)&&c.role==='control'&&Number(c.user_id)===Number(s.control_user_id)),
      products:products.filter(p=>Number(p.session_id)===Number(s.id)).map(p=>({id:p.base_code_id==null?null:Number(p.base_code_id),code:p.code_snapshot,name:p.name_snapshot,spec:p.spec_snapshot??''})),
    })).filter(s=>s.canJoinAnchor||s.canJoinControl||s.canJoinOperator);
    return {...desk,joinable, rooms, schedules:desk.schedules.filter(r=>!roomId||r.roomId===roomId),active:desk.active.filter(r=>!roomId||r.roomId===roomId)};
  }
  async checkoutPreview(user:AuthUser,id:number,role?:string){
    const a=await loadLiveAccess(this.em,user);requireUse(a);
    const s=await sessionRow(this.em,a.companyId,id);
    const ownRole=liveReportRoleFor(a.userId,this.people(s),role??null);
    if(!ownRole||ownRole==='operator')liveFail('只能查看本人主播或中控的下播信息',403);
    const [clock]:Row[]=await this.em.query("SELECT DATE_FORMAT(start_at,'%Y-%m-%d %H:%i:%s') start_text,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text FROM live_session_checkins WHERE company_id=? AND session_id=? AND user_id=? AND role=?",[a.companyId,id,a.userId,ownRole]);
    if(!clock)liveFail('请先确认本人上播',400);
    const endAt=clock.end_text??wallNow(liveClock.now());
    let salesCents:number|null=null,reason='',orderCount:number|null=null,capture:Awaited<ReturnType<typeof captureOrders>>|null=null;
    try {const c=await captureOrders(this.orders,a.companyId,s,s.end_text??endAt);capture=c;salesCents=c.sales;orderCount=c.orders.length;}catch(e){reason=(e as Error).message;}
    const [profile]=await this.em.query('SELECT pay_type,hourly_rate FROM users WHERE company_id=? AND id=?',[a.companyId,a.userId]);
    const {liveArchiveHourlyRate,liveComputeWage}=await import('@kudesi/shared');
    const rate=liveArchiveHourlyRate(profile?{payType:profile.pay_type,hourlyRate:profile.hourly_rate==null?null:Number(profile.hourly_rate)}:null);
    const wageExcluded=ownRole==='control'&&await commissionOnlyControl(this.em,a.companyId,a.userId);
    const wage=!wageExcluded&&rate&&endAt>clock.start_text?liveComputeWage({startAt:clock.start_text,endAt,hourlyRateCents:rate}):null;
    const reports=await reportsOf(this.em,a.companyId,id);
    const preview=!capture?null:await this.preview(this.em,a,{...s,orders_capture_status:'ready'},[{role:'anchor',sales_cents:capture.sales,store_lines_json:capture.lines},...reports.filter(r=>r.role==='control')]);
    return {role:ownRole,startAt:clock.start_text,endAt,minutes:Math.max(0,Math.ceil((+liveFromText(endAt)!-+liveFromText(clock.start_text)!)/60000)),salesCents,orderCount,reason,wage,wageMessage:wageExcluded?'该岗位担任中控只计提成，不计时薪':null,commission:preview?.[ownRole as 'anchor'|'control']??null,locked:reportsLocked(s,liveClock.now())};
  }
  private async actualReport(user:AuthUser,a:LiveAccess,first:Row,role:string,input:ReportInput){
    const [clock]:Row[]=await this.em.query("SELECT *,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text FROM live_session_checkins WHERE company_id=? AND session_id=? AND role=? AND user_id=?",[a.companyId,first.id,role,a.userId]);
    if(!clock)liveFail('请先确认本人上播，不能代其他岗位报下播',400);
    const at=liveClock.now(),endAt=clock.end_text??wallNow(at);
    let capture:Awaited<ReturnType<typeof captureOrders>>|null=null,error='';
    try{capture=await captureOrders(this.orders,a.companyId,first,role==='anchor'?endAt:first.end_text??endAt);}catch(e){error=String((e as Error).message).slice(0,500);}
    if(role==='control'&&(!Number.isSafeInteger(input.adSpendCents)||input.adSpendCents!<0))liveFail('请核对本场投流费用，没有填0',400);
    await this.ds.transaction(async em=>{
      await lockCompany(em,a.companyId);const s=await sessionRow(em,a.companyId,Number(first.id),true);
      if(reportsLocked(s,liveClock.now())||!['live','pending_report','returned'].includes(s.status))liveFail('本场已锁定，不能再报下播',409);
      if(s.start_text!==first.start_text||s.end_text!==first.end_text||JSON.stringify(channelsOf(s))!==JSON.stringify(channelsOf(first)))liveFail('场次信息变化，请刷新重试',409);
      if(await closedDay(em,a.companyId,s.session_day))liveFail('本场已进入结算，不能修改',409);
      const [current]=await em.query('SELECT end_at FROM live_session_checkins WHERE company_id=? AND id=? FOR UPDATE',[a.companyId,clock.id]);
      if(current.end_at && !clock.end_text)liveFail('本人已下播，请刷新查看',409);
      if(endAt<=s.start_text)liveFail('下播时间必须晚于开播时间',400);
      await em.query('UPDATE live_session_checkins SET end_at=COALESCE(end_at,?) WHERE company_id=? AND id=?',[endAt,a.companyId,clock.id]);
      const lines=capture?.lines.map(l=>({...l,adSpendCents:role==='control'?(input.storeLines?.find(v=>v.storeId===l.storeId)?.adSpendCents??(capture!.lines.length===1?input.adSpendCents??0:0)):0}))??channelStores(channelsOf(s)).map(v=>({storeId:v.id,platform:v.platform,salesCents:0,adSpendCents:0,verified:false,reason:error}));
      if(role==='control'&&lines.reduce((n,l)=>n+l.adSpendCents,0)!==input.adSpendCents)liveFail('请逐店核对投流费用',400);
      const basis=capture?.orders.map(o=>({shopId:o.shopId,orderId:o.orderId,refundCents:o.refund.cents}))??null;
      await em.query(`INSERT INTO live_session_reports (company_id,session_id,role,reporter_user_id,end_at,sales_cents,ad_spend_cents,orders_total_cents,order_count,note,store_lines_json,order_basis_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE end_at=VALUES(end_at),sales_cents=VALUES(sales_cents),ad_spend_cents=VALUES(ad_spend_cents),orders_total_cents=VALUES(orders_total_cents),order_count=VALUES(order_count),note=VALUES(note),store_lines_json=VALUES(store_lines_json),order_basis_json=VALUES(order_basis_json),revision=revision+1`,[a.companyId,s.id,role,a.userId,endAt,capture?.sales??0,role==='control'?input.adSpendCents:null,capture?.sales??null,capture?.orders.length??0,text(input.note)||null,JSON.stringify(lines),basis?JSON.stringify(basis):null]);
      if(capture){
        await em.query('SAVEPOINT live_order_capture');
        try{await persistCapture(em,a.companyId,Number(s.id),capture,at);}
        catch(e){
          await em.query('ROLLBACK TO SAVEPOINT live_order_capture');
          error=String((e as Error).message).slice(0,500);
          await em.query("UPDATE live_sessions SET orders_capture_status='pending',orders_capture_error=? WHERE company_id=? AND id=?",[error,a.companyId,s.id]);
          await em.query('UPDATE live_session_reports SET order_basis_json=NULL,orders_total_cents=NULL,store_lines_json=? WHERE company_id=? AND session_id=? AND role=?',[JSON.stringify(lines.map(l=>({...l,verified:false,reason:error}))),a.companyId,s.id,role]);
        }
        await em.query('RELEASE SAVEPOINT live_order_capture');
      }
      else await em.query("UPDATE live_sessions SET orders_capture_status='pending',orders_capture_error=? WHERE company_id=? AND id=?",[error,a.companyId,s.id]);
      await em.query('UPDATE live_sessions SET first_reported_at=COALESCE(first_reported_at,?),report_deadline=COALESCE(report_deadline,?),revision=revision+1 WHERE company_id=? AND id=?',[wallNow(at),wallNow(new Date(+at+REPORT_WINDOW_MS)),a.companyId,s.id]);
      if(role==='anchor'){
        await em.query("UPDATE live_sessions SET end_at=?,status='pending_report' WHERE company_id=? AND id=?",[endAt,a.companyId,s.id]);
        await em.query("UPDATE live_schedules SET status='finished' WHERE company_id=? AND session_id=? AND status='live'",[a.companyId,s.id]);
      }
    });
    return {ok:true};
  }

  /** 聚水潭只读授权状态（订单、退款读取是否可用）。 */
  async integrationStatus(user: AuthUser) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    return this.orders.status(a.companyId);
  }

  // ---------- 订单候选与报下播 ----------
  async orderCandidates(user: AuthUser, sessionId: number, q: { endAt?: string; refresh?: boolean; storeId?: number }) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const s = await sessionRow(this.em, a.companyId, sessionId);
    if (!a.canManage && !liveReportRoleFor(a.userId, this.people(s))) liveFail('只有本场主播、中控本人可以查看可勾选的订单', 403);
    const endAt = q.endAt ? this.parseTime(q.endAt, '下播时间') : s.end_text ?? wallNow(liveClock.now());
    const stores = channelStores(channelsOf(s));
    const selected = q.storeId ? stores.find(v => v.id === q.storeId) : stores[0];
    if (q.storeId && !selected) liveFail('店铺不属于本场',400);
    const found = await this.orders.candidates(a.companyId, { id: Number(s.id), shopId: selected ? selected.jstShopId || null : s.jst_shop_id ?? null, startAt: s.start_text, endAt }, { refresh: !!q.refresh });
    return { ...found, startAt: s.start_text, endAt };
  }

  async report(user: AuthUser, sessionId: number, input: ReportInput) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    // 外部订单查询放在事务之外；事务里只写库
    const first = await sessionRow(this.em, a.companyId, sessionId);
    const role = liveReportRoleFor(a.userId, this.people(first), input.role ?? null);
    if (!role) liveFail('只能由主播、中控（或排定的运营）本人为自己的角色报下播，管理人员不能代填', 403);
    if(reportsLocked(first,liveClock.now()))liveFail('首位报下播已满30分钟，本场已锁定并进入审核，不能再填报',409);
    if(first.checkin_mode && role!=='operator')return this.actualReport(user,a,first,role,input);
    const operatorAt=liveClock.now();
    const [operatorClock]:Row[]=first.checkin_mode&&role==='operator'?await this.em.query("SELECT id,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text FROM live_session_checkins WHERE company_id=? AND session_id=? AND user_id=? AND role='operator'",[a.companyId,sessionId,a.userId]):[];
    if(first.checkin_mode&&role==='operator'&&!operatorClock)liveFail('请先选择运营身份上播',400);
    const endAt = operatorClock?(operatorClock.end_text??wallNow(operatorAt)):this.parseTime(input.endAt, '下播时间');
    if(role==='control'&&!input.storeLines&&input.adSpendCents==null)liveFail('中控请填写本场投流费用（没有投流填 0）',400);
    const multi = channelsOf(first).length > 0;
    const shops=channelStores(channelsOf(first));
    const lineInput=input.storeLines ?? (shops.length===1?[{storeId:shops[0].id,platform:shops[0].platform,salesCents:input.salesCents,adSpendCents:input.adSpendCents??0,orderIds:input.orderIds,reason:input.note}]:[]);
    const checked = multi ? await checkStoreLines(this.orders, a.companyId, first, lineInput, endAt,role==='operator') : null;
    const sales = checked ? checked.sales : input.salesCents;
    if (!Number.isSafeInteger(sales) || sales < 0 || sales > 10_000_000_000) liveFail('销售额需要是 0 到 1 亿元之间的金额', 400);
    const needsOrders = role !== 'operator';
    const orderIds = [...new Set((input.orderIds ?? []).map((v) => String(v)))];
    let picked: Array<{ orderId: string; innerId: string; amountCents: number; payTime: string | null; status: string }> = [];
    if (needsOrders && !checked) {
      const found = await this.orders.candidates(a.companyId, { id: Number(first.id), shopId: first.jst_shop_id ?? null, startAt: first.start_text, endAt }, { refresh: true });
      if (!found.available) liveFail(`不能报下播：${found.reason || '暂时查不到聚水潭订单'}`, 409);
      if (found.truncated) liveFail(found.reason || '聚水潭订单过多，只列出了一部分，请联系管理员核对本场订单', 409);
      // 旧系统规则：聚水潭查到本场订单就必须勾选；本场时间段内确实没有订单时可以直接报
      if (found.orders.some((o) => o.paid && !o.cancelled) && !orderIds.length) liveFail('请勾选本场订单（聚水潭查到本场时间段内的订单）', 400);
      const by = new Map(found.orders.map((o) => [o.orderId, o]));
      for (const id of orderIds) {
        const o = by.get(id);
        if (!o) liveFail(`订单 ${id} 不在本场的聚水潭订单范围内，请刷新订单后重新勾选`, 400);
        if (!o!.paid || o!.cancelled) liveFail(`订单 ${id} 未付款或已取消，不能勾选`, 400);
        picked.push({ orderId: o!.orderId, innerId: o!.innerId, amountCents: o!.amountCents, payTime: o!.payTime, status: o!.status });
      }
    } else picked = [];
    const adSpend = role === 'control' ? (checked ? checked.ad : input.adSpendCents ?? null) : null;
    if (role === 'control' && (adSpend === null || !Number.isSafeInteger(adSpend) || adSpend < 0 || adSpend > 10_000_000_000)) liveFail('中控请填写本场投流费用（没有投流填 0）', 400);
    if (role !== 'control' && input.adSpendCents) liveFail('只有中控填写投流费用', 400);
    await this.ds.transaction(async (em) => {
      await lockCompany(em, a.companyId);
      const s = await sessionRow(em, a.companyId, sessionId, true);
      if(reportsLocked(s,liveClock.now()))liveFail('本场已锁定，不能再填报',409);
      if (!['live', 'pending_report', 'returned'].includes(s.status)) liveFail(s.status === 'submitted' ? '已提交审核，需审核人退回后才能修改' : '该场次已审核，不能再修改');
      if (liveReportRoleFor(a.userId, this.people(s), role) !== role) liveFail('只能由本人填报自己的角色', 403);
      if (s.jst_shop_id !== first.jst_shop_id || JSON.stringify(channelsOf(s)) !== JSON.stringify(channelsOf(first)) || s.start_text !== first.start_text) liveFail('场次信息已变化，请刷新后重试');
      const now = liveClock.now();
      const end = liveFromText(endAt)!;
      if (end.getTime() <= liveFromText(s.start_text)!.getTime()) liveFail('下播时间必须晚于上播时间', 400);
      if (end.getTime() > now.getTime() + SKEW_MS) liveFail('下播时间不能晚于现在', 400);
      if(operatorClock){
        const [current]=await em.query("SELECT DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text FROM live_session_checkins WHERE company_id=? AND id=? FOR UPDATE",[a.companyId,operatorClock.id]);
        if(current.end_text&&current.end_text!==operatorClock.end_text)liveFail('本人已下播，请刷新查看',409);
        await em.query('UPDATE live_session_checkins SET end_at=COALESCE(end_at,?) WHERE company_id=? AND id=?',[endAt,a.companyId,operatorClock.id]);
      }
      if(s.checkin_mode)await em.query('UPDATE live_sessions SET first_reported_at=COALESCE(first_reported_at,?),report_deadline=COALESCE(report_deadline,?) WHERE company_id=? AND id=?',[wallNow(now),wallNow(new Date(+now+REPORT_WINDOW_MS)),a.companyId,sessionId]);
      const total = picked.reduce((t, o) => t + o.amountCents, 0);
      const [old] = await em.query('SELECT id FROM live_session_reports WHERE company_id = ? AND session_id = ? AND role = ? FOR UPDATE', [a.companyId, sessionId, role]);
      let reportId: number;
      if (old) {
        reportId = Number(old.id);
        await em.query(
          `UPDATE live_session_reports SET reporter_user_id = ?, end_at = ?, sales_cents = ?, ad_spend_cents = ?, orders_total_cents = ?, order_count = ?, note = ?, revision = revision + 1 WHERE company_id = ? AND id = ?`,
          [a.userId, endAt, sales, adSpend, needsOrders ? total : null, picked.length, text(input.note) || null, a.companyId, reportId]);
        await em.query('DELETE FROM live_session_orders WHERE company_id = ? AND report_id = ?', [a.companyId, reportId]);
      } else {
        const ins = await em.query(
          `INSERT INTO live_session_reports (company_id, session_id, role, reporter_user_id, end_at, sales_cents, ad_spend_cents, orders_total_cents, order_count, note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [a.companyId, sessionId, role, a.userId, endAt, sales, adSpend, needsOrders ? total : null, picked.length, text(input.note) || null]);
        reportId = Number(ins.insertId);
      }
      if (await closedDay(em,a.companyId,s.session_day))liveFail('该日期已进入工资结算，不能修改');
      if (checked) await persistStoreLines(em,a.companyId,sessionId,reportId,checked);
      for (const o of picked) {
        await em.query('INSERT INTO live_session_orders (company_id, session_id, report_id, order_id, inner_order_id, amount_cents, pay_time, order_status, shop_id) VALUES (?,?,?,?,?,?,?,?,?)',
          [a.companyId, sessionId, reportId, o.orderId, o.innerId || null, o.amountCents, o.payTime, o.status || null, s.jst_shop_id ?? '']);
      }
      if (role === 'anchor') {
        // 场次下播时间以主播所报为准；离开「直播中」后房间和主播就空出来了
        await em.query("UPDATE live_sessions SET end_at = ?, status = IF(status = 'live', 'pending_report', status), revision = revision + 1 WHERE company_id = ? AND id = ?", [endAt, a.companyId, sessionId]);
        await em.query("UPDATE live_schedules SET status = 'finished' WHERE company_id = ? AND session_id = ? AND status = 'live'", [a.companyId, sessionId]);
      } else await em.query('UPDATE live_sessions SET revision = revision + 1 WHERE company_id = ? AND id = ?', [a.companyId, sessionId]);
      if (role === 'anchor' && s.status === 'live') await liveHandover(em, a.companyId, sessionId);
    });
    return { ok: true };
  }

  async submissionStatus(user: AuthUser) {
    requireUse(await loadLiveAccess(this.em, user));
    return { ...await this.flow.startReadiness(user, 'live-session-review') };
  }

  // ---------- 提交审核 ----------
  async submit(user: AuthUser, sessionId: number) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    // 被退回、流程还在的：走流程的「重新提交」（它自己开事务，所以不能放进下面的事务里）
    const peek = await sessionRow(this.em, a.companyId, sessionId);
    if (peek.status === 'returned' && peek.flow_run_id) {
      if (![peek.anchor_user_id, peek.control_user_id].some((v) => v && Number(v) === a.userId) && !a.canManage) liveFail('只有本场主播或中控可以提交审核', 403);
      const [run] = await this.em.query('SELECT revision FROM flow_runs WHERE company_id = ? AND id = ?', [a.companyId, peek.flow_run_id]);
      if (run) { const r = await this.flow.resubmit(user, Number(peek.flow_run_id), { revision: Number(run.revision), payload: { sessionId } }); return { runId: r.id }; }
    }
    // 资格、下播报告和月份检查都在适配器 validateStart；业务记录由适配器 onStart 和流程同一个事务写入
    const detail = await this.flow.start(user, 'live-session-review', { sessionId }, undefined, { internal: true });
    return { runId: detail.id };
  }

  // ---------- 列表与详情 ----------
  async list(user: AuthUser, q: SessionQuery) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const where = ['s.company_id = ?'], params: unknown[] = [a.companyId];
    if (!(a.canView || a.canViewAll)) {
      where.push(`(s.anchor_user_id = ? OR s.control_user_id = ? OR s.operator_user_id = ? OR s.started_by = ? OR ${REVIEWER_SQL})`);
      params.push(a.userId, a.userId, a.userId, a.userId, String(a.userId));
    }
    if (q.from && liveIsDay(q.from)) { where.push('s.session_date >= ?'); params.push(q.from); }
    if (q.to && liveIsDay(q.to)) { where.push('s.session_date <= ?'); params.push(q.to); }
    if (q.roomId) { where.push('s.room_id = ?'); params.push(q.roomId); }
    if (q.anchorId) { where.push('s.anchor_user_id = ?'); params.push(q.anchorId); }
    if (q.controlId) { where.push('s.control_user_id = ?'); params.push(q.controlId); }
    if (q.status && LIVE_SESSION_STATUS[q.status]) { where.push('s.status = ?'); params.push(q.status); }
    const page = Math.max(1, q.page ?? 1), size = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const [count] = await this.em.query(`SELECT COUNT(*) n FROM live_sessions s WHERE ${where.join(' AND ')}`, params);
    const rows: Row[] = await this.em.query(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.start_at DESC, s.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
    return { total: Number(count.n), page, pageSize: size, rows: rows.map(serializeSession) };
  }

  /** 预估提成：按场次日期适用的规则版本，用主播（没有则中控）所报销售额试算；只向本人展示本人的角色。 */
  private async preview(em: EntityManager, a: LiveAccess, s: Row, reports: Row[]) {
    if (s.status === 'approved') return null;
    const base = primaryReport(reports);
    if(s.checkin_mode && s.orders_capture_status!=='ready')return {available:false,reason:'本场订单和退款待核对',anchor:null,control:null,operator:null};
    if (!base) return { available: false, reason: '主播报下播后显示预估提成', anchor: null, control: null, operator: null };
    const version = liveVersionFor(await ruleVersions(em, a.companyId), s.session_day);
    if (!version) return { available: false, reason: '没有适用的提成规则版本', anchor: null, control: null, operator: null };
    const control = reports.find((r) => r.role === 'control');
    const platforms = linesOf(base).length ? livePlatformCommissions(version.rules, linesOf(base).map(l => ({ platform:l.platform, salesCents:l.salesCents, adSpendCents: control ? linesOf(control).find(c=>c.storeId===l.storeId)?.adSpendCents ?? 0 : null }))) : [];
    const legacy = liveComputeCommission({ rules: version.rules, finalSalesCents: num(base.sales_cents), adSpendCents: control?.ad_spend_cents == null ? null : Number(control.ad_spend_cents) });
    const r = platforms.length ? { ...legacy, roiScaled: null, belowRoi: platforms.some(p=>p.belowRoi), ...Object.fromEntries(['anchor','control','operator'].map(role=>[role,{rateUnits:platforms.length===1?platforms[0][role as 'anchor'].rateUnits:0,amountCents:platforms.reduce((n,p)=>n+p[role as 'anchor'].amountCents,0)}])) } as typeof legacy : legacy;
    const p = { aggregated:platforms.length>1, available: true, reason: '', basisSalesCents: r.finalSalesCents, adSpendCents: r.adSpendCents, roiScaled: r.roiScaled, belowRoi: r.belowRoi, ruleVersionId: version.id,
      anchor: r.anchor, control: s.control_user_id ? r.control : null, operator: s.operator_user_id && Number(s.operator_user_id) !== Number(s.control_user_id) ? r.operator : null };
    return liveFilterPreview(a.canViewAll, a.userId, { ...this.people(s), status: s.status }, p);
  }

  async detail(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const em = this.em;
    const s = await sessionRow(em, a.companyId, id);
    if (!(await this.visible(em, a, s))) liveFail('没有查看这场直播的权限', 403);
    const [products, reports, orders, commissions, wages] = await Promise.all([
      em.query('SELECT base_code_id, code_snapshot, name_snapshot, spec_snapshot FROM live_session_products WHERE company_id = ? AND session_id = ? ORDER BY sort_order', [a.companyId, id]) as Promise<Row[]>,
      reportsOf(em, a.companyId, id),
      em.query("SELECT order_id, report_id, amount_cents, DATE_FORMAT(pay_time,'%Y-%m-%d %H:%i:%s') pay_text, order_status FROM live_session_orders WHERE company_id = ? AND session_id = ? ORDER BY id", [a.companyId, id]) as Promise<Row[]>,
      em.query('SELECT c.platform, c.user_id, c.role, c.rate_units, c.amount_cents, c.roi_scaled, c.below_roi, c.rule_version_id, e.name FROM live_commission_records c JOIN users e ON e.id = c.user_id AND e.company_id = c.company_id WHERE c.company_id = ? AND c.session_id = ? ORDER BY c.id', [a.companyId, id]) as Promise<Row[]>,
      em.query("SELECT w.role, w.user_id, w.minutes, w.hourly_rate_cents, w.amount_cents, w.rate_source, w.adjust_note, DATE_FORMAT(w.start_at,'%Y-%m-%d %H:%i:%s') start_text, DATE_FORMAT(w.end_at,'%Y-%m-%d %H:%i:%s') end_text FROM live_wage_records w WHERE w.company_id = ? AND w.session_id = ?", [a.companyId, id]) as Promise<Row[]>,
    ]);
    const names = new Map<number, string>((await em.query(`SELECT id, name FROM users WHERE company_id = ? AND id IN (${[...new Set([...reports.map((r) => r.reporter_user_id), s.anchor_user_id])].map(() => '?').join(',')})`, [a.companyId, ...new Set([...reports.map((r) => r.reporter_user_id), s.anchor_user_id])])).map((r: Row) => [Number(r.id), r.name]));
    const mineAll = a.canViewAll;
    const showMoney = (userId: number) => mineAll || userId === a.userId; // 提成金额：全员权限者看全部，其他人只看本人
    const ppl = this.people(s);
    const editable = !reportsLocked(s,liveClock.now()) && ['live', 'pending_report', 'returned'].includes(s.status);
    const canRoles = (['anchor', 'control', 'operator'] as const).filter((r) => editable && liveReportRoleFor(a.userId, ppl, r) === r);
    let flow: unknown = null;
    if (s.flow_run_id) { try { flow = await this.flow.detail(user, Number(s.flow_run_id)); } catch { flow = null; } }
    return {
      ...serializeSession(s),
      capturedOrders: await em.query("SELECT store_id storeId,platform,shop_id shopId,order_id orderId,paid,amount_cents amountCents,refund_cents refundCents,order_status status,DATE_FORMAT(order_at,'%Y-%m-%d %H:%i:%s') orderAt FROM live_session_order_snapshots WHERE company_id=? AND session_id=? ORDER BY order_at,shop_id,order_id",[a.companyId,id]),
      myCheckins: await em.query("SELECT role,DATE_FORMAT(start_at,'%Y-%m-%d %H:%i:%s') startAt,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') endAt FROM live_session_checkins WHERE company_id=? AND session_id=? AND user_id=?",[a.companyId,id,a.userId]),
      controlCommissionOnly: await commissionOnlyControl(em, a.companyId, s.control_user_id),
      products: products.map((p) => ({ id: p.base_code_id == null ? null : Number(p.base_code_id), code: p.code_snapshot, name: p.name_snapshot, spec: p.spec_snapshot ?? '' })),
      reports: reports.map((r) => ({
        pending:!!s.checkin_mode&&r.role!=='operator'&&!r.manual_actor_id&&!r.order_basis_json, storeLines: linesOf(r), role: r.role, roleLabel: LIVE_ROLE_LABEL[r.role], manualActorId:r.manual_actor_id?Number(r.manual_actor_id):null, reporter: { id: Number(r.reporter_user_id), name: names.get(Number(r.reporter_user_id)) ?? '' }, endAt: r.end_text, salesCents: num(r.sales_cents),
        adSpendCents: numOrNull(r.ad_spend_cents), ordersTotalCents: numOrNull(r.orders_total_cents), orderCount: Number(r.order_count), note: r.note ?? '',
        orders: orders.filter((o) => Number(o.report_id) === Number(r.id)).map((o) => ({ orderId: o.order_id, amountCents: num(o.amount_cents), payTime: o.pay_text, status: o.order_status })),
      })),
      commissions: commissions.filter((c) => showMoney(Number(c.user_id))).map((c) => ({ platform: c.platform || '', userId: Number(c.user_id), name: c.name, role: c.role, roleLabel: LIVE_ROLE_LABEL[c.role], rateUnits: Number(c.rate_units), amountCents: num(c.amount_cents), roiScaled: numOrNull(c.roi_scaled), belowRoi: !!c.below_roi })),
      wages: wages.filter((w) => showMoney(Number(w.user_id))).map((w) => ({ role:w.role, userId: Number(w.user_id), minutes: Number(w.minutes), hourlyRateCents: num(w.hourly_rate_cents), amountCents: num(w.amount_cents), rateSource: w.rate_source, note: w.adjust_note, startAt: w.start_text, endAt: w.end_text })),
      wage: wages.filter(w=>w.role==='anchor'&&showMoney(Number(w.user_id))).map(w=>({userId:Number(w.user_id),minutes:Number(w.minutes),hourlyRateCents:num(w.hourly_rate_cents),amountCents:num(w.amount_cents),rateSource:w.rate_source,note:w.adjust_note,startAt:w.start_text,endAt:w.end_text}))[0]??null,
      preview: await this.preview(em, a, s, reports),
      me: { reportRoles: canRoles, canSubmit: (!s.checkin_mode || reportsLocked(s,liveClock.now())) && ['pending_report', 'returned'].includes(s.status) && ([ppl.anchorId, ppl.controlId].includes(a.userId) || a.canManage), isManager: a.canManage },
      submission: ['pending_report', 'returned'].includes(s.status)
        ? s.status === 'returned' && s.flow_run_id ? { ready: true, message: '修改完成后可重新提交原审核流程。' } : await this.flow.startReadiness(user, 'live-session-review')
        : null,
      flow,
    };
  }

  /** 审核人（或管理人员）按所选来源、运营、工资设置试算提成与工资，不写库。 */
  async reviewPreview(user: AuthUser, id: number, form: ReviewForm) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const s = await sessionRow(this.em, a.companyId, id);
    if (!a.canManage && !(await this.isReviewer(this.em, s, a.userId))) liveFail('没有审核这场直播的权限', 403);
    try { return await previewApproval(this.em, a.companyId, id, form); } catch (e) { if (e instanceof LiveRuleError) liveFail(e.message, 400); throw e; }
  }

  /** 报下播表单里随输入刷新的预估提成（旧版 /commission/preview）：按场次日期适用的规则版本，只向本人展示本人角色。 */
  async previewFor(user: AuthUser, sessionId: number, input: { sales: string; adSpend?: string }) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const s = await sessionRow(this.em, a.companyId, sessionId);
    if (!(await this.visible(this.em, a, s))) liveFail('没有查看这场直播的权限', 403);
    if (s.status === 'approved') return null;
    if (new Set(channelsOf(s).map(c=>c.platform)).size>1) return { available:false, reason:'多平台提成在逐店填报保存后按平台分别试算',anchor:null,control:null,operator:null };
    const version = liveVersionFor(await ruleVersions(this.em, a.companyId), s.session_day);
    if (!version) return { available: false, reason: `没有适用于 ${s.session_day} 的提成规则版本`, anchor: null, control: null, operator: null };
    let sales: number | null, ad: number | null;
    try { sales = liveYuanToCents(input.sales, '销售额'); ad = liveYuanToCents(input.adSpend ?? '', '投流费用'); } catch (e) { if (e instanceof LiveRuleError) liveFail(e.message, 400); throw e; }
    if (sales === null) return { available: false, reason: '填写销售额后显示预估提成', anchor: null, control: null, operator: null };
    if (input.adSpend === undefined || input.adSpend === '') {
      const [c] = await this.em.query("SELECT ad_spend_cents FROM live_session_reports WHERE company_id = ? AND session_id = ? AND role = 'control'", [a.companyId, sessionId]);
      ad = c?.ad_spend_cents === null || c?.ad_spend_cents === undefined ? null : Number(c.ad_spend_cents);
    }
    const r = liveComputeCommission({ rules: version.rules, finalSalesCents: sales, adSpendCents: ad });
    const p = { available: true, reason: '', basisSalesCents: r.finalSalesCents, adSpendCents: r.adSpendCents, roiScaled: r.roiScaled, belowRoi: r.belowRoi, ruleVersionId: version.id,
      anchor: r.anchor, control: s.control_user_id ? r.control : null, operator: s.operator_user_id && Number(s.operator_user_id) !== Number(s.control_user_id) ? r.operator : null };
    return liveFilterPreview(a.canViewAll, a.userId, { ...this.people(s), status: s.status }, p);
  }

  // ---------- 我的直播 ----------
  async workbench(user: AuthUser) {
    const a = await loadLiveAccess(this.em, user);
    if (!a.canDesk && !a.canView && !a.isOperations) liveFail('无权使用我的直播', 403);
    const em = this.em, c = a.companyId, uid = a.userId, now = liveClock.now();
    const today = liveToday(now), month = today.slice(0, 7), mine = '(s.anchor_user_id = ? OR s.control_user_id = ? OR s.operator_user_id = ?)';
    const [active, schedules, recent, comm, wage, commRows, wageRows] = await Promise.all([
      em.query(`${SESSION_SELECT} WHERE s.company_id = ? AND ${mine} AND s.status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY s.start_at DESC LIMIT 20`, [c, uid, uid, uid, ...ACTIVE]) as Promise<Row[]>,
      em.query(`SELECT s.*, DATE_FORMAT(s.schedule_date,'%Y-%m-%d') schedule_day, DATE_FORMAT(s.start_at,'%Y-%m-%d %H:%i:%s') start_text, DATE_FORMAT(s.end_at,'%Y-%m-%d %H:%i:%s') end_text, a.name anchor_name, cc.name control_name, o.name operator_name
          FROM live_schedules s JOIN users a ON a.id = s.anchor_user_id AND a.company_id = s.company_id LEFT JOIN users cc ON cc.id = s.control_user_id AND cc.company_id = s.company_id LEFT JOIN users o ON o.id = s.operator_user_id AND o.company_id = s.company_id
         WHERE s.company_id = ? AND (s.anchor_user_id = ? OR s.control_user_id = ? OR s.operator_user_id = ?) AND s.status IN ('scheduled','live') AND s.schedule_date BETWEEN ? AND ? ORDER BY s.start_at`, [c, uid, uid, uid, today, liveAddDays(today, 7)]) as Promise<Row[]>,
      em.query(`${SESSION_SELECT} WHERE s.company_id = ? AND ${mine} ORDER BY s.start_at DESC LIMIT 20`, [c, uid, uid, uid]) as Promise<Row[]>,
      em.query("SELECT COALESCE(SUM(amount_cents),0) total FROM live_commission_records WHERE company_id = ? AND user_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ?", [c, uid, month]),
      em.query("SELECT COALESCE(SUM(amount_cents),0) total, COALESCE(SUM(minutes),0) minutes FROM live_wage_records WHERE company_id = ? AND user_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ?", [c, uid, month]),
      em.query("SELECT r.platform, r.id, r.session_id, DATE_FORMAT(r.session_date,'%Y-%m-%d') d, r.role, r.final_sales_cents, r.rate_units, r.amount_cents, s.room_name FROM live_commission_records r JOIN live_sessions s ON s.id = r.session_id AND s.company_id = r.company_id WHERE r.company_id = ? AND r.user_id = ? AND DATE_FORMAT(r.session_date,'%Y-%m') = ? ORDER BY r.session_date DESC, r.id DESC LIMIT 100", [c, uid, month]) as Promise<Row[]>,
      em.query("SELECT w.id, w.session_id, DATE_FORMAT(w.session_date,'%Y-%m-%d') d, w.minutes, w.hourly_rate_cents, w.amount_cents, s.room_name FROM live_wage_records w JOIN live_sessions s ON s.id = w.session_id AND s.company_id = w.company_id WHERE w.company_id = ? AND w.user_id = ? AND DATE_FORMAT(w.session_date,'%Y-%m') = ? ORDER BY w.session_date DESC, w.id DESC LIMIT 100", [c, uid, month]) as Promise<Row[]>,
    ]);
    const activeClocks:Row[]=active.length?await em.query(`SELECT session_id,role,DATE_FORMAT(start_at,'%Y-%m-%d %H:%i:%s') startAt,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') endAt FROM live_session_checkins WHERE company_id=? AND user_id=? AND session_id IN (${active.map(()=>'?').join(',')}) ORDER BY start_at`,[c,uid,...active.map(s=>s.id)]):[];
    const legacyReports:Row[]=active.some(s=>!s.checkin_mode)?await em.query(`SELECT session_id,role,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') endAt FROM live_session_reports WHERE company_id=? AND reporter_user_id=? AND session_id IN (${active.map(()=>'?').join(',')})`,[c,uid,...active.map(s=>s.id)]):[];
    const nowText = wallNow(now);
    return {
      today, month, identity: { isOperations:!!a.isOperations,isAnchor: a.isAnchor, isControl: a.isControl, canManage: a.canManage },
      active: active.map(s=>{
        let own=activeClocks.find(clock=>Number(clock.session_id)===Number(s.id))??null;
        if(!s.checkin_mode&&!own){const role=Number(s.anchor_user_id)===uid?'anchor':Number(s.control_user_id)===uid?'control':'operator';const report=legacyReports.find(r=>Number(r.session_id)===Number(s.id)&&r.role===role);own={role,startAt:s.start_text,endAt:report?.endAt??null};}
        return {...serializeSession(s),myCheckin:own?{role:own.role,startAt:own.startAt,endAt:own.endAt}:null};
      }),
      schedules: schedules.map((r) => ({ ...serializeSchedule(r), canStart: r.status === 'scheduled' && r.end_text > nowText, mineRole: Number(r.anchor_user_id) === uid ? 'anchor' : Number(r.control_user_id) === uid ? 'control' : 'operator' })),
      recent: recent.map(serializeSession),
      monthCommissionCents: num(comm[0].total), monthWageCents: num(wage[0].total), monthWageMinutes: num(wage[0].minutes),
      commissionRows: commRows.map((r) => ({ platform:r.platform, id: Number(r.id), sessionId: Number(r.session_id), date: String(r.d), roomName: String(r.room_name), role: String(r.role), roleLabel: LIVE_ROLE_LABEL[String(r.role)] ?? String(r.role), finalSalesCents: num(r.final_sales_cents), rateUnits: Number(r.rate_units), amountCents: num(r.amount_cents) })),
      wageRows: wageRows.map((r) => ({ id: Number(r.id), sessionId: Number(r.session_id), date: String(r.d), roomName: String(r.room_name), minutes: Number(r.minutes), hourlyRateCents: num(r.hourly_rate_cents), amountCents: num(r.amount_cents) })),
    };
  }

  async history(user: AuthUser, q: { mode?: string; month?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
    const a = await loadLiveAccess(this.em, user);
    if (!a.canDesk && !a.canView && !a.isOperations) liveFail('无权使用我的直播', 403);
    const em = this.em, c = a.companyId, uid = a.userId, now = liveClock.now();
    const mine = '(s.anchor_user_id = ? OR s.control_user_id = ? OR s.operator_user_id = ?)';
    const month = liveIsMonth(q.month) ? q.month : liveToday(now).slice(0, 7);
    const where = [`s.company_id = ?`, mine], params: unknown[] = [c, uid, uid, uid];
    if (q.mode === 'range') {
      if (!liveIsDay(q.from) || !liveIsDay(q.to) || q.from > q.to) liveFail('请选择有效的起止日期', 400);
      where.push('s.session_date BETWEEN ? AND ?'); params.push(q.from, q.to);
    } else if (q.mode !== 'all') {
      const b = liveMonthBounds(month); where.push('s.session_date >= ? AND s.session_date < ?'); params.push(b.from, b.until);
    }
    const page = Math.max(1, q.page ?? 1), size = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const [count] = await em.query(`SELECT COUNT(*) n FROM live_sessions s WHERE ${where.join(' AND ')}`, params);
    const rows: Row[] = await em.query(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.start_at DESC, s.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
    const ids = rows.map((r) => Number(r.id));
    const [comm, wages]: [Row[], Row[]] = ids.length ? await Promise.all([
      em.query(`SELECT session_id, role, amount_cents FROM live_commission_records WHERE company_id = ? AND user_id = ? AND session_id IN (${ids.map(() => '?').join(',')})`, [c, uid, ...ids]),
      em.query(`SELECT session_id, amount_cents, minutes FROM live_wage_records WHERE company_id = ? AND user_id = ? AND session_id IN (${ids.map(() => '?').join(',')})`, [c, uid, ...ids]),
    ]) : [[], []];
    const summary = async (from: string | null, until: string | null) => {
      const range = from ? ' AND s.session_date >= ? AND s.session_date < ?' : '';
      const rp = from ? [from, until] : [];
      const [sess] = await em.query(`SELECT COUNT(*) n, COALESCE(SUM(TIMESTAMPDIFF(MINUTE, s.start_at, s.end_at)),0) minutes FROM live_sessions s WHERE s.company_id = ? AND ${mine} AND s.end_at IS NOT NULL${range}`, [c, uid, uid, uid, ...rp]);
      const dr = from ? ' AND session_date >= ? AND session_date < ?' : '';
      const [cm] = await em.query(`SELECT COALESCE(SUM(amount_cents),0) total FROM live_commission_records WHERE company_id = ? AND user_id = ?${dr}`, [c, uid, ...rp]);
      const [wg] = await em.query(`SELECT COALESCE(SUM(amount_cents),0) total, COALESCE(SUM(minutes),0) minutes FROM live_wage_records WHERE company_id = ? AND user_id = ?${dr}`, [c, uid, ...rp]);
      return { sessions: Number(sess.n), minutes: Number(sess.minutes), commissionCents: num(cm.total), wageCents: num(wg.total), wageMinutes: num(wg.minutes) };
    };
    const thisB = liveMonthBounds(liveToday(now).slice(0, 7));
    return {
      mode: q.mode === 'range' || q.mode === 'all' ? q.mode : 'month', month, total: Number(count.n), page, pageSize: size,
      rows: rows.map((r) => ({
        ...serializeSession(r), myRoles: ['anchor', 'control', 'operator'].filter((role) => Number(r[`${role}_user_id`]) === uid).map((x) => LIVE_ROLE_LABEL[x]),
        commissionCents: comm.filter((x) => Number(x.session_id) === Number(r.id)).reduce((t, x) => t + num(x.amount_cents), 0) || null,
        wageCents: wages.find((x) => Number(x.session_id) === Number(r.id)) ? num(wages.find((x) => Number(x.session_id) === Number(r.id))!.amount_cents) : null,
      })),
      summary: { all: await summary(null, null), thisMonth: await summary(thisB.from, thisB.until), lastMonth: await summary(thisB.previousFrom, thisB.from) },
    };
  }
}

function wallText(v: unknown): string { return liveToText(v) ?? String(v); }
