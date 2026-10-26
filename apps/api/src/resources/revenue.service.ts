import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = ['sales', 'refund', 'adCost', 'platformFee', 'purchaseCost', 'otherCost', 'profit', 'orders'] as const;
type Totals = Record<(typeof FIELDS)[number], number> & { days: number };

const zero = (): Totals => ({ sales: 0, refund: 0, adCost: 0, platformFee: 0, purchaseCost: 0, otherCost: 0, profit: 0, orders: 0, days: 0 });

/** 营业执照营收：把该执照名下各店铺在日期范围内的“店铺经营数据”汇总。数据现在是手工录入/导入，以后接入接口不影响这里。 */
@Injectable()
export class RevenueService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async licenseSummary(user: AuthUser, licenseId: number, from: string, to: string) {
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new BadRequestException('日期范围不合法');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw new BadRequestException('一次最多查询一年');

    const license = await this.dataSource.manager.findOne(ResourceRecord, { where: { id: licenseId, companyId: user.companyId, type: 'licenses' }, select: ['id', 'title'] });
    if (!license) throw new NotFoundException('营业执照不存在');

    const stores = await this.dataSource.query(
      `SELECT id, title FROM resource_records
       WHERE company_id = ? AND type = 'stores' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.licenseId')) AS UNSIGNED) = ?
       ORDER BY id`,
      [user.companyId, licenseId],
    );
    const total = zero();
    const rows: Array<{ storeId: number; name: string } & Totals> = stores.map((s: { id: number; title: string }) => ({ storeId: s.id, name: s.title, ...zero() }));
    if (rows.length > 0) {
      const ids = rows.map((r) => r.storeId);
      const num = (f: string) => `SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.${f}')) AS SIGNED), 0))`;
      const sums = await this.dataSource.query(
        `SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.storeId')) AS UNSIGNED) AS sid, COUNT(*) AS days,
                ${FIELDS.map((f) => `${num(f)} AS ${f}`).join(', ')}
         FROM resource_records
         WHERE company_id = ? AND type = 'store-daily-metrics'
           AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.day')) BETWEEN ? AND ?
           AND CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.storeId')) AS UNSIGNED) IN (${ids.map(() => '?').join(',')})
         GROUP BY sid`,
        [user.companyId, from, to, ...ids],
      );
      for (const s of sums as Array<Record<string, string | number>>) {
        const row = rows.find((r) => r.storeId === Number(s.sid));
        if (!row) continue;
        row.days = Number(s.days);
        for (const f of FIELDS) row[f] = Number(s[f]);
      }
    }
    for (const r of rows) {
      total.days = Math.max(total.days, r.days);
      for (const f of FIELDS) total[f] += r[f];
    }
    return { licenseId, licenseTitle: license.title, from, to, stores: rows, total };
  }
}
