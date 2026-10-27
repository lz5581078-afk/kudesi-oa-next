import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { normalizeFeeBookingNodes, FEE_SEED_CATEGORIES, FEE_SEED_ITEMS, createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { ResourcesService } from './resources.service';

const YES = (v: string) => (v === '是' ? 'yes' : 'no');
const PLATFORM: Record<string, string> = { 不限: 'any', 拼多多: 'pdd', 淘宝: 'taobao', 天猫: 'tmall', 抖音: 'douyin', 京东: 'jd', 快手: 'kuaishou' };
const FLOW: Record<string, string> = { 按金额判断: 'by_amount', 是: 'yes', 否: 'no' };

/** 导入旧程序默认的费用档案（类别树 + 费用项目）。按“默认数据编号 / 费用编号”幂等：已有的不动，缺的补上。 */
@Injectable()
export class FeeArchiveService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly resources: ResourcesService) {}

  async seed(user: AuthUser) {
    const can = createChecker(user.permissions);
    if (!can('resource.finance-fee-items.create') || !can('resource.finance-fee-categories.create')) throw new ForbiddenException('没有新建费用档案的权限');
    const em = this.dataSource.manager;
    const cats = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-fee-categories' } });
    const catBySeed = new Map<string, number>();
    for (const c of cats) if (typeof c.data.seedKey === 'string' && c.data.seedKey) catBySeed.set(c.data.seedKey, c.id);
    let catCreated = 0;
    // 父类别先建：反复扫描，直到没有可建的
    let pending = FEE_SEED_CATEGORIES.filter(([id]) => !catBySeed.has(id));
    while (pending.length) {
      const next: typeof pending = [];
      let progressed = false;
      for (const c of pending) {
        const [id, name, parent, order, subtitle] = c;
        if (parent && !catBySeed.has(parent)) { next.push(c); continue; }
        const rec = await this.resources.create(user, 'finance-fee-categories', { name, parentId: parent ? catBySeed.get(parent) : undefined, subtitle: subtitle || undefined, sort: order, seedKey: id });
        catBySeed.set(id, rec.id);
        catCreated++;
        progressed = true;
      }
      if (!progressed) break;
      pending = next;
    }
    const items = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-fee-items' }, select: ['id', 'data'] });
    const have = new Set(items.map((i) => String(i.data.code ?? '')));
    let itemCreated = 0;
    for (const [code, name, cat, subject, object, platform, common, required, flow, remark] of FEE_SEED_ITEMS) {
      if (have.has(code)) continue;
      await this.resources.create(user, 'finance-fee-items', {
        code, name, direction: 'expense', categoryId: catBySeed.get(cat), accountingSubject: subject || undefined, defaultObject: normalizeFeeBookingNodes(object).join('、') || undefined,
        platform: PLATFORM[platform] ?? 'any', isCommon: YES(common), requiredObject: YES(required), needFlow: FLOW[flow] ?? undefined, remark: remark || undefined,
      });
      itemCreated++;
    }
    return { categoriesCreated: catCreated, itemsCreated: itemCreated, categoriesTotal: FEE_SEED_CATEGORIES.length, itemsTotal: FEE_SEED_ITEMS.length };
  }
}
