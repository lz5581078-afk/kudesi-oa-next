import { Injectable } from '@nestjs/common';
import { createChecker, type BossException, type SummaryCard } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { WorkspaceModuleRegistry } from '../workspace/module-registry';
import { SupervisionService } from './supervision.service';

/** 把售后、兜底监督的汇总接进老板总控台和岗位工作台（没有对应页面权限的人拿不到数据）。 */
@Injectable()
export class ServiceWorkspaceProvider {
  constructor(private readonly supervision: SupervisionService, registry: WorkspaceModuleRegistry) {
    registry.register({
      key: 'supervision',
      exceptions: (u) => this.exceptions(u),
      bossCards: (u) => this.supervisionCards(u),
      deskCards: (u) => this.supervisionCards(u),
    });
    registry.register({
      key: 'after-sales',
      bossCards: (u) => this.serviceCards(u),
      deskCards: (u) => this.serviceCards(u),
    });
  }

  private can(u: AuthUser, key: string) { return createChecker(u.permissions)(key); }

  async exceptions(user: AuthUser): Promise<{ total: number; rows: BossException[]; byUser: Record<number, number> }> {
    if (!this.can(user, 'supervision.center.view')) return { total: 0, rows: [], byUser: {} };
    const o = await this.supervision.overview(user);
    const byUser: Record<number, number> = {};
    for (const e of o.exceptions) if (e.ownerId) byUser[e.ownerId] = (byUser[e.ownerId] ?? 0) + 1;
    return {
      total: o.exceptions.length,
      rows: o.exceptions.slice(0, 20).map((e) => ({ id: e.id, title: e.title, severity: e.severity, ownerName: e.ownerName, storeName: e.storeName, escalatedLevel: e.level })),
      byUser,
    };
  }

  private async supervisionCards(user: AuthUser): Promise<SummaryCard[]> {
    if (!this.can(user, 'supervision.center.view')) return [];
    const s = await this.supervision.summary(user.companyId);
    return [{ key: 'supervision-open', label: '未关闭异常', value: s.exceptions.open, hint: `紧急 ${s.exceptions.urgent} · 已升级 ${s.exceptions.escalated}`, tone: s.exceptions.urgent ? 'bad' : s.exceptions.open ? 'warn' : 'normal', page: 'supervision.center', module: 'supervision' }];
  }

  private async serviceCards(user: AuthUser): Promise<SummaryCard[]> {
    const cards: SummaryCard[] = [];
    const needAs = this.can(user, 'after-sales.table.view'), needAp = this.can(user, 'after-sales.appeals.view');
    if (!needAs && !needAp) return cards;
    const s = await this.supervision.summary(user.companyId);
    if (needAs) cards.push({ key: 'after-sales-open', label: '售后待处理', value: s.afterSales.open, hint: `已超时 ${s.afterSales.overdue} · 将到期 ${s.afterSales.dueSoon}`, tone: s.afterSales.overdue ? 'bad' : s.afterSales.dueSoon ? 'warn' : 'normal', page: 'after-sales.table', module: 'after-sales' });
    if (needAp) cards.push({ key: 'appeals-open', label: '订单申诉在办', value: s.appeals.open, hint: `已超时 ${s.appeals.overdue} · 待提交平台 ${s.appeals.toSubmit}`, tone: s.appeals.overdue ? 'bad' : 'normal', page: 'after-sales.appeals', module: 'after-sales' });
    return cards;
  }
}
