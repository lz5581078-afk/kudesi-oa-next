import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { liveToday, type SummaryCard } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { WorkspaceModuleRegistry } from '../workspace/module-registry';
import { loadLiveAccess } from './live-access';
import { liveClock, num, wallNow } from './live-core';

/** 把直播汇总接进老板总控台和岗位工作台（运营看直播摘要，主播/中控看自己的）。 */
@Injectable()
export class LiveWorkspaceModule {
  constructor(@InjectDataSource() private readonly ds: DataSource, registry: WorkspaceModuleRegistry) {
    registry.register({
      key: 'live',
      bossCards: (user) => this.bossCards(user),
      deskCards: (user, type) => this.deskCards(user, type),
    });
  }

  /** 老板总控台：待审核的场次、已到时间没有上播的排场（需要有直播查看权限，否则不出卡片）。 */
  async bossCards(user: AuthUser): Promise<SummaryCard[]> {
    const a = await loadLiveAccess(this.ds.manager, user);
    if (!a.canView) return [];
    const now = wallNow(liveClock.now());
    const [[pending], [missed]] = await Promise.all([
      this.ds.query("SELECT COUNT(*) n FROM live_sessions WHERE company_id = ? AND status = 'submitted'", [a.companyId]),
      this.ds.query("SELECT COUNT(*) n FROM live_schedules WHERE company_id = ? AND status = 'scheduled' AND start_at < ?", [a.companyId, now]),
    ]);
    return [
      { key: 'live-pending', label: '直播待审核', value: num(pending.n), tone: num(pending.n) ? 'warn' : 'normal', page: 'features.live', module: 'live' },
      { key: 'live-missed', label: '过时未上播', value: num(missed.n), tone: num(missed.n) ? 'bad' : 'normal', hint: '已过开始时间还没上播的排场', page: 'features.live', module: 'live' },
    ];
  }

  /** 岗位工作台：运营看今天的排场和正在直播的场数；主播、中控看自己的排场和本月提成。 */
  async deskCards(user: AuthUser, type: string): Promise<SummaryCard[]> {
    const a = await loadLiveAccess(this.ds.manager, user);
    const today = liveToday(liveClock.now());
    if (type === 'operations') {
      const own = !a.canView;
      const mine = own ? ' AND (anchor_user_id = ? OR control_user_id = ? OR operator_user_id = ?)' : '';
      const p = own ? [user.id, user.id, user.id] : [];
      const [[sch], [live]] = await Promise.all([
        this.ds.query(`SELECT COUNT(*) n FROM live_schedules WHERE company_id = ? AND schedule_date = ? AND status <> 'cancelled'${mine}`, [a.companyId, today, ...p]),
        this.ds.query(`SELECT COUNT(*) n FROM live_sessions WHERE company_id = ? AND status = 'live'${mine}`, [a.companyId, ...p]),
      ]);
      const page = a.canView ? 'features.live' : 'features.live-desk';
      return [
        { key: 'live-today', label: own ? '我今天的直播排场' : '今日直播排场', value: num(sch.n), page, module: 'live' },
        { key: 'live-now', label: '正在直播', value: num(live.n), page, module: 'live' },
      ];
    }
    if (type === 'live_anchor' || type === 'live_control') {
      const month = today.slice(0, 7);
      const [[sch], [comm]] = await Promise.all([
        this.ds.query("SELECT COUNT(*) n FROM live_schedules WHERE company_id = ? AND schedule_date >= ? AND status = 'scheduled' AND (anchor_user_id = ? OR control_user_id = ?)", [a.companyId, today, user.id, user.id]),
        this.ds.query("SELECT COALESCE(SUM(amount_cents),0) total FROM live_commission_records WHERE company_id = ? AND user_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ?", [a.companyId, user.id, month]),
      ]);
      return [
        { key: 'live-mine', label: '我的待播排场', value: num(sch.n), page: 'features.live-desk', module: 'live' },
        { key: 'live-commission', label: '本月提成（元）', value: (num(comm.total) / 100).toFixed(2), page: 'features.live-desk', module: 'live' },
      ];
    }
    return [];
  }
}
