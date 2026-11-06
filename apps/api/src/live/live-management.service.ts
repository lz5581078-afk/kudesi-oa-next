import { createTrialPerson } from '../workforce/create-trial-person';
import { scheduleProducts } from './live-schedule.service';
import { liveSessionResult, liveHandover } from './live-notification-events';
import { channelStores, channelsOf, validateChannels, assertAccountTime, checkStoreLines, persistStoreLines } from './live-platforms';
import { LiveChannelInput, LiveStoreLine } from '@kudesi/shared';
import { LiveOrderSource, LiveOrder } from './live-order-source';
import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  liveComputeWage,
  liveFromText,
  liveToText,
  liveRulesFromInput,
  LiveRuleError,
  type LiveRulesInput,
} from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import {
  liveDouyinAccounts,
  liveDouyinStores,
  livePeople,
  liveRoomList,
  loadLiveAccess,
  requireManage,
} from './live-access';
import { closedDay, liveClock, liveFail, lockCompany, reportsOf, sessionRow, text } from './live-core';

export interface ManualInput {
  confirmUnlinkedStores?: boolean;
  scheduleId?: number;
  channels?:LiveChannelInput[]; storeLines?:LiveStoreLine[];
  sessionId?: number;
  roomId: number;
  anchorId: number;
  controlId?: number | null;
  operatorId?: number | null;
  douyinAccountId: number;
  storeId: number;
  startAt: string;
  endAt: string;
  salesCents: number;
  adSpendCents: number;
  controlSalesCents?: number;
  operatorSalesCents?: number;
  reason: string;
  orderIds?: string[];
}
@Injectable()
export class LiveManagementService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly orders: LiveOrderSource,
  ) {}
  private async manage(user: AuthUser) {
    const a = await loadLiveAccess(this.ds.manager, user);
    requireManage(a);
    return a;
  }
  private async audit(
    em: import('typeorm').EntityManager,
    u: AuthUser,
    action: string,
    type: string,
    id: number,
    detail: unknown,
  ) {
    await em.query(
      `INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES (?,?,?,?,?,?)`,
      [u.companyId, u.id, action, type, String(id), JSON.stringify(detail)],
    );
  }
  async room(user: AuthUser, id: number, input: { ownerId?: number | null; products: string }) {
    await this.manage(user);
    return this.ds.transaction(async (em) => {
      await lockCompany(em, user.companyId);
      if (!(await liveRoomList(em, user.companyId)).some((r) => r.id === id)) liveFail('直播间不存在', 404);
      if (input.ownerId) {
        const [u] = await em.query("SELECT id FROM users WHERE company_id=? AND id=? AND status='active'", [
          user.companyId,
          input.ownerId,
        ]);
        if (!u) liveFail('负责人不存在或已停用', 400);
      }
      await em.query(
        `INSERT INTO live_room_settings(company_id,room_id,owner_user_id,products,updated_by) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id),products=VALUES(products),updated_by=VALUES(updated_by)`,
        [user.companyId, id, input.ownerId ?? null, input.products, user.id],
      );
      await this.audit(em, user, 'live.room.update', 'live-room', id, input);
      return { ok: true };
    });
  }
  async trial(user: AuthUser, input: { name: string; hourlyRateCents?: number }) {
    await this.manage(user);
    return createTrialPerson(this.ds, user, input);
  }
  async updateRule(user: AuthUser, id: number, input: { effectiveFrom: string; note?: string; rules: LiveRulesInput }) {
    await this.manage(user);
    let rules;
    try {
      rules = liveRulesFromInput(input.rules);
    } catch (e) {
      if (e instanceof LiveRuleError) liveFail(e.message, 400);
      throw e;
    }
    return this.ds.transaction(async (em) => {
      await lockCompany(em, user.companyId);
      const [v] = await em.query('SELECT * FROM live_commission_rule_versions WHERE company_id=? AND id=?', [
        user.companyId,
        id,
      ]);
      if (!v) liveFail('规则不存在', 404);
      const [used] = await em.query(
        'SELECT COUNT(*) n FROM live_commission_records WHERE company_id=? AND rule_version_id=?',
        [user.companyId, id],
      );
      if (Number(used.n)) liveFail('该版本已用于工资核算，请修改生效日期并另存新版本，历史快照保留');
      const [dup] = await em.query(
        'SELECT id FROM live_commission_rule_versions WHERE company_id=? AND effective_from=? AND id<>?',
        [user.companyId, input.effectiveFrom, id],
      );
      if (dup) liveFail('该生效日期已有规则');
      await this.audit(em, user, 'live.rule.update', 'live-rule', id, { before: v, after: input });
      await em.query(
        'UPDATE live_commission_rule_versions SET effective_from=?,rules_json=?,note=? WHERE company_id=? AND id=?',
        [input.effectiveFrom, JSON.stringify(rules), text(input.note) || null, user.companyId, id],
      );
      return { id };
    });
  }
  /** 人事补报保存为待审核场次；已有场次用同一编号补报，沿用统一审核。 */
  async manual(user: AuthUser, input: ManualInput) {
    await this.manage(user);
    const start = liveFromText(input.startAt),
      end = liveFromText(input.endAt);
    if (!start || !end || +end <= +start || +end > +liveClock.now() + 300000)
      liveFail('请填写有效的上下播时间，结束不能晚于现在', 400);
    liveComputeWage({ startAt: input.startAt, endAt: input.endAt, hourlyRateCents: 1 });
    if (!text(input.reason)) liveFail('特殊情况必须填写原因', 400);
    const original = input.sessionId ? await sessionRow(this.ds.manager,user.companyId,input.sessionId) : null;
    const historical = original ? channelsOf(original).length ? channelsOf(original) : [{accountId:Number(original.douyin_account_id),accountName:String(original.douyin_account_name),platform:'douyin',storeIds:[Number(original.store_id)],stores:[{id:Number(original.store_id),name:String(original.store_name),jstShopId:String(original.jst_shop_id||'')}]}] : null;
    const channelWarnings: string[] = [];
    const resolveChannels = async (em: import('typeorm').EntityManager) => {
      const warnings: string[] = [];
      const result = await validateChannels(em,user.companyId,input.channels ?? [{accountId:input.douyinAccountId,storeIds:[input.storeId]}],message=>warnings.push(message));
      if (warnings.length && !input.confirmUnlinkedStores) throw new ConflictException({code:'LIVE_MANUAL_CHANNEL_CONFIRM_REQUIRED',message:`${warnings.join('；')}。请核对本次补报数据，确认后可继续保存并进入原审核流程。`});
      channelWarnings.splice(0,channelWarnings.length,...warnings);
      return result;
    };
    const channels = historical ?? await resolveChannels(this.ds.manager);
    if(original && input.channels && JSON.stringify(input.channels.map(c=>[c.accountId,[...c.storeIds].sort()])) !== JSON.stringify(channels.map(c=>[c.accountId,[...c.storeIds].sort()]))) liveFail('补报须沿用原场次账号和店铺',400);
    const shops=channelStores(channels);
    const lineInput=input.storeLines ?? (shops.length===1?[{storeId:shops[0].id,platform:shops[0].platform,salesCents:input.salesCents,adSpendCents:input.adSpendCents,orderIds:input.orderIds,reason:input.reason}]:[]);
    const checked = await checkStoreLines(this.orders,user.companyId,{id:input.sessionId??0,channels_json:channels,start_text:liveToText(start)!},lineInput.map(l=>({...l,reason:l.reason||input.reason})),liveToText(end)!,true);
    if(input.storeLines){input.salesCents=checked.sales;input.adSpendCents=checked.ad;input.controlSalesCents=checked.sales;input.operatorSalesCents=checked.sales;}
    return this.ds.transaction(async (em) => {
      await lockCompany(em, user.companyId);
      const startAt = liveToText(start)!,
        endAt = liveToText(end)!,
        day = startAt.slice(0, 10);
      if (await closedDay(em, user.companyId, day)) liveFail('该日期已经提交工资结算，不能补报');
      const room = (await liveRoomList(em, user.companyId)).find((r) => r.id === input.roomId);
      const staff = await livePeople(em, user.companyId);
      if (
        !room ||
        !staff.anchors.some((p) => p.id === input.anchorId) ||
        (input.controlId && !staff.controls.some((p) => p.id === input.controlId))
      )
        liveFail('请选择有效房间、主播和中控', 400);
      if (input.anchorId === input.controlId || input.anchorId === input.operatorId)
        liveFail('主播不能同时担任中控或运营', 400);
      if (input.operatorId) {
        const [op] = await em.query("SELECT id FROM users WHERE company_id=? AND id=? AND status='active'", [
          user.companyId,
          input.operatorId,
        ]);
        if (!op) liveFail('运营不存在', 400);
      }
      const current = original ? channels : await resolveChannels(em);
      if(JSON.stringify(current)!==JSON.stringify(channels)) liveFail('账号或店铺绑定已变化，请刷新后补报',400);
      const first=channels[0], account={id:first.accountId,name:channels.map(c=>c.accountName).join(' / ').slice(0,200)}, store=first.stores[0];
      input.douyinAccountId=account.id;input.storeId=store.id;
      const [schedule] = input.scheduleId ? await em.query(
        "SELECT *,DATE_FORMAT(start_at,'%Y-%m-%d %H:%i:%s') start_text FROM live_schedules WHERE company_id=? AND id=? FOR UPDATE",
        [user.companyId,input.scheduleId],
      ) : [];
      if (input.scheduleId) {
        if (!schedule || schedule.status === 'cancelled' || Number(schedule.session_id||0)!==Number(input.sessionId||0) || (original && Number(original.schedule_id)!==input.scheduleId) || (!original && schedule.status!=='scheduled')) liveFail('排场已变更或已有场次，请刷新后选择原排场');
        if (!original && (Number(schedule.room_id)!==input.roomId || Number(schedule.anchor_user_id)!==input.anchorId ||
          Number(schedule.control_user_id||0)!==Number(input.controlId||0) || Number(schedule.operator_user_id||0)!==Number(input.operatorId||0))) liveFail('排场人员已变更，请重新选择');
        if (await closedDay(em,user.companyId,schedule.start_text.slice(0,10))) liveFail('原排班日期已进入工资结算，不能补报');
        const other = await em.query("SELECT id FROM live_schedules WHERE company_id=? AND id<>? AND status<>'cancelled' AND (room_id=? OR anchor_user_id=?) AND start_at<? AND end_at>? LIMIT 1",
          [user.companyId,schedule.id,input.roomId,input.anchorId,endAt,startAt]);
        if (other.length) liveFail('实际补报时间与其他排场的房间或主播重合，请核对下播时间');
        const planned = channelsOf(schedule);
        const expected = planned.length ? planned : [{accountId:Number(schedule.douyin_account_id),storeIds:schedule.store_id?[Number(schedule.store_id)]:[]}];
        if (!original && (expected.length !== channels.length || expected.some((p,i)=>p.accountId!==channels[i].accountId ||
          (p.storeIds.length && (p.storeIds.length!==channels[i].storeIds.length || p.storeIds.some(id=>!channels[i].storeIds.includes(id))))))) liveFail('请沿用排场的直播账号和店铺');
      }
      await assertAccountTime(em,user.companyId,channels,startAt,endAt,input.sessionId,input.scheduleId ?? (original?.schedule_id?Number(original.schedule_id):undefined));
      if (!original || schedule) {
        const conflict = await em.query("SELECT id FROM live_sessions WHERE company_id=? AND id<>? AND (room_id=? OR anchor_user_id=?) AND start_at<? AND COALESCE(end_at,'9999-12-31')>? LIMIT 1",
          [user.companyId,input.sessionId??0,input.roomId,input.anchorId,endAt,startAt]);
        if (conflict.length) liveFail('该时间已有相同房间或主播的其他场次，请核对实际时间');
      }
      let id = input.sessionId;
      if (id) {
        const s = await sessionRow(em, user.companyId, id, true);
        if(original && JSON.stringify(channelsOf(s))!==JSON.stringify(channelsOf(original)))liveFail('场次账号店铺已变化，请刷新后补报');
        if(s.jst_shop_id!==store!.jstShopId)liveFail('店铺聚水潭绑定与原场次不同，请先核对绑定');
        if (!['live', 'pending_report', 'returned'].includes(s.status)) liveFail('待审核或已审核场次不能补报');
        if (await closedDay(em, user.companyId, s.session_day,{sessionId:Number(s.id)})) liveFail('原场次日期已进入结算');
        if (
          Number(s.anchor_user_id) !== input.anchorId ||
          Number(s.control_user_id ?? 0) !== Number(input.controlId ?? 0) ||
          (!schedule && s.start_text !== startAt) ||
          Number(s.room_id) !== input.roomId ||
          Number(s.store_id) !== input.storeId ||
          Number(s.douyin_account_id) !== input.douyinAccountId ||
          Number(s.operator_user_id ?? 0) !== Number(input.operatorId ?? 0)
        )
          liveFail('补报现有场次须沿用原房间、人员、店铺、账号和开播时间');
      } else {
        const ins = await em.query(
          `INSERT INTO live_sessions(company_id,room_id,room_name,anchor_user_id,control_user_id,operator_user_id,douyin_account_id,douyin_account_name,store_id,store_name,jst_shop_id,session_date,start_at,end_at,status,started_by,started_role,report_source,manual_reason,manual_actor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_report',?,'manager','manual',?,?)`,
          [
            user.companyId,
            room!.id,
            room!.name,
            input.anchorId,
            input.controlId ?? null,
            input.operatorId ?? null,
            account!.id,
            account!.name,
            store!.id,
            store!.name,
            store!.jstShopId,
            day,
            startAt,
            endAt,
            user.id,
            text(input.reason),
            user.id,
          ],
        );
        id = Number(ins.insertId);
      }
      if (schedule && !original) {
        await em.query('UPDATE live_sessions SET schedule_id=? WHERE company_id=? AND id=?',[schedule.id,user.companyId,id]);
        let order=0;
        for (const p of scheduleProducts(schedule.products_json)) {
          await em.query('INSERT INTO live_session_products(company_id,session_id,base_code_id,code_snapshot,name_snapshot,spec_snapshot,sort_order) VALUES(?,?,?,?,?,?,?)',[user.companyId,id,p.id,p.code,p.name,p.spec||null,order++]);
        }
        await em.query("UPDATE live_schedules SET session_id=?,status='finished',updated_by=? WHERE company_id=? AND id=? AND status IN ('scheduled','live')",[id,user.id,user.companyId,schedule.id]);
      }
      await em.query('UPDATE live_sessions SET channels_json=? WHERE company_id=? AND id=?',[JSON.stringify(channels),user.companyId,id]);
      const before = await reportsOf(em, user.companyId, id!);
      // 先保留既有勾单，手工订单另走服务端查询后补写（见 controller）。
      for (const [role, uid] of [
        ['anchor', input.anchorId],
        ['control', input.controlId],
        ['operator', input.operatorId],
      ] as const) {
        if (!uid) continue;
        const existing = before.find((r) => r.role === role);
        if (existing)
          await em.query(
            'UPDATE live_session_reports SET end_at=?,sales_cents=?,ad_spend_cents=?,manual_actor_id=?,note=?,revision=revision+1 WHERE company_id=? AND id=?',
            [
              endAt,
              role === 'control'
                ? (input.controlSalesCents ?? input.salesCents)
                : role === 'operator'
                  ? (input.operatorSalesCents ?? input.salesCents)
                  : input.salesCents,
              role === 'control' ? input.adSpendCents : null,
              user.id,
              text(input.reason),
              user.companyId,
              existing.id,
            ],
          );
        else
          await em.query(
            `INSERT INTO live_session_reports(company_id,session_id,role,reporter_user_id,end_at,sales_cents,ad_spend_cents,order_source,note,manual_actor_id) VALUES (?,?,?,?,?,?,?,'manual',?,?)`,
            [
              user.companyId,
              id,
              role,
              uid,
              endAt,
              role === 'control'
                ? (input.controlSalesCents ?? input.salesCents)
                : role === 'operator'
                  ? (input.operatorSalesCents ?? input.salesCents)
                  : input.salesCents,
              role === 'control' ? input.adSpendCents : null,
              text(input.reason),
              user.id,
            ],
          );
      }
      if (checked) {
        const saved = await reportsOf(em,user.companyId,id!);
        for(const report of saved) {
          const roleSales=report.role==='control'?input.controlSalesCents:report.role==='operator'?input.operatorSalesCents:undefined;
          const result=!input.storeLines&&checked.lines.length===1&&roleSales!==undefined?{...checked,lines:checked.lines.map(l=>({...l,salesCents:roleSales})),sales:roleSales}:checked;
          await persistStoreLines(em,user.companyId,id!,Number(report.id),result);
        }
      }
      await em.query(
        "UPDATE live_sessions SET start_at=?,session_date=?,end_at=?,status=IF(status='live','pending_report',status),report_source='manual',manual_reason=?,manual_actor_id=?,revision=revision+1 WHERE company_id=? AND id=?",
        [startAt, day, endAt, text(input.reason), user.id, user.companyId, id],
      );
      await em.query(
        "UPDATE live_schedules SET status='finished' WHERE company_id=? AND session_id=? AND status='live'",
        [user.companyId, id],
      );
      await this.audit(em, user, 'live.manual.report', 'live-session', id!, { before, input, channelWarnings });
      const [noticeRow] = await em.query('SELECT revision FROM live_sessions WHERE company_id=? AND id=?',[user.companyId,id]);
      await liveSessionResult(em,user.companyId,id!,`manual:${id}:${noticeRow.revision}`,'直播场次已由人事补报或修正');
      await liveHandover(em,user.companyId,id!);
      return { id: id! };
    });
  }
}
