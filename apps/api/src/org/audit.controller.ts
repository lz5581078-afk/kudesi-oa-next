import { Controller, Get, Query } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';

/** 审计日志：系统操作记录（AuditLog）与资料变更记录（ResourceChangeLog）合并只读查看。 */
@Controller('audit')
export class AuditController {
  constructor(private readonly ds: DataSource) {}

  @RequirePermission('system.audit.view')
  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query('source') source?: string,
    @Query('keyword') keyword?: string,
    @Query('actorId') actorId?: string,
    @Query('page') pageRaw?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const page = Math.max(1, Number(pageRaw) || 1);
    const size = 30;
    const kw = (keyword ?? '').trim();
    const actor = /^\d+$/.test(actorId ?? '') ? Number(actorId) : null;
    // 时间范围：按日期（含起止当天）
    const day = (v?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? (v as string) : null);
    const fromDay = day(from);
    const toDay = day(to);
    const range = (col: string, p: unknown[]) => {
      let w = '';
      if (fromDay) { w += ` AND ${col} >= ?`; p.push(`${fromDay} 00:00:00`); }
      if (toDay) { w += ` AND ${col} < DATE_ADD(?, INTERVAL 1 DAY)`; p.push(`${toDay} 00:00:00`); }
      return w;
    };
    const parts: string[] = [];
    const params: unknown[] = [];
    if (source !== 'resource') {
      let w = 'a.company_id = ?';
      const p: unknown[] = [u.companyId];
      if (actor) { w += ' AND a.actor_id = ?'; p.push(actor); }
      if (kw) { w += ' AND (a.action LIKE ? OR a.resource_type LIKE ? OR a.resource_id LIKE ?)'; p.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); }
      w += range('a.created_at', p);
      parts.push(`SELECT CONVERT('system' USING utf8mb4) COLLATE utf8mb4_unicode_ci AS source, a.id AS id, a.created_at AS at, a.actor_id AS actorId, CONVERT(a.action USING utf8mb4) COLLATE utf8mb4_unicode_ci AS action, CONVERT(a.resource_type USING utf8mb4) COLLATE utf8mb4_unicode_ci AS resourceType, CONVERT(a.resource_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS resourceId, CONVERT(CAST(a.detail AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS detail FROM audit_logs a WHERE ${w}`);
      params.push(...p);
    }
    if (source !== 'system') {
      let w = 'c.company_id = ?';
      const p: unknown[] = [u.companyId];
      if (actor) { w += ' AND c.actor_id = ?'; p.push(actor); }
      if (kw) { w += ' AND (c.action LIKE ? OR c.resource_type LIKE ? OR c.note LIKE ?)'; p.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); }
      w += range('c.created_at', p);
      parts.push(`SELECT CONVERT('resource' USING utf8mb4) COLLATE utf8mb4_unicode_ci AS source, c.id AS id, c.created_at AS at, c.actor_id AS actorId, CONVERT(c.action USING utf8mb4) COLLATE utf8mb4_unicode_ci AS action, CONVERT(c.resource_type USING utf8mb4) COLLATE utf8mb4_unicode_ci AS resourceType, CONVERT(CAST(c.resource_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS resourceId, CONVERT(CAST(JSON_OBJECT('before', c.before_json, 'after', c.after_json, 'note', c.note) AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS detail FROM resource_change_logs c WHERE ${w}`);
      params.push(...p);
    }
    const union = parts.join(' UNION ALL ');
    const total = (await this.ds.query(`SELECT COUNT(*) AS n FROM (${union}) t`, params))[0].n;
    const rows = await this.ds.query(
      `SELECT t.*, u.name AS actorName FROM (${union}) t LEFT JOIN users u ON u.id = t.actorId ORDER BY t.at DESC, t.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`,
      params,
    );
    return {
      total: Number(total),
      page,
      size,
      items: rows.map((r: any) => ({ ...r, id: String(r.id), detail: r.detail ? safeJson(r.detail) : null })),
    };
  }
}

function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return s; }
}

/** 银行卡资金概况：按账户类型汇总余额（期初余额 + 财务现金银行已过账流水），不含已停用、已归档的账户。 */
@Controller('bank-fund')
export class BankFundController {
  constructor(private readonly ds: DataSource, private readonly crypto: CryptoService) {}

  @RequirePermission('resource.bank-accounts.view')
  @Get()
  async summary(@CurrentUser() u: AuthUser) {
    const rows: Array<{ id: number; title: string; status: string; kind: string | null; balance: string | null; bank: string | null; owner: string | null; secrets: string | null; archived: Date | null }> = await this.ds.query(
      `SELECT id, title, status, JSON_UNQUOTE(JSON_EXTRACT(data,'$.kind')) AS kind, JSON_UNQUOTE(JSON_EXTRACT(data,'$.balance')) AS balance,
              JSON_UNQUOTE(JSON_EXTRACT(data,'$.bank')) AS bank, JSON_UNQUOTE(JSON_EXTRACT(data,'$.ownerName')) AS owner,
              secrets, archived_at AS archived
       FROM resource_records WHERE company_id = ? AND type = 'bank-accounts' ORDER BY id`,
      [u.companyId],
    );
    const moves: Array<{ id: number; s: string }> = await this.ds.query(
      "SELECT account_id AS id, SUM(amount_cents) AS s FROM finance_entries WHERE company_id = ? AND kind = 'bank' GROUP BY account_id",
      [u.companyId],
    );
    const move = new Map(moves.map((m) => [Number(m.id), Number(m.s)]));
    const all = rows.filter((r) => !r.archived);
    const COMPANY = new Set(['company_public', 'company_card', 'cashier_account']);
    const STORE = new Set(['store_public', 'store_personal_card']);
    const KINDS = ['company_public', 'company_card', 'cashier_account', 'store_public', 'store_personal_card'];
    const cents = (r: { id: number; balance: string | null }) => (Math.round(Number(r.balance ?? 0)) || 0) + (move.get(Number(r.id)) ?? 0);
    const live = all.filter((r) => r.status !== 'inactive');
    const sum = (list: typeof rows) => list.reduce((a, r) => a + cents(r), 0);
    const accountNo = (r: { secrets: string | null }) => {
      try {
        const token = r.secrets ? (JSON.parse(r.secrets) as Record<string, string>).accountNo : '';
        return token ? this.crypto.decrypt(token) : null;
      } catch {
        return null;
      }
    };
    return {
      totalCents: sum(live),
      companyCents: sum(live.filter((r) => COMPANY.has(r.kind ?? ''))),
      storeCents: sum(live.filter((r) => STORE.has(r.kind ?? ''))),
      abnormalCount: live.filter((r) => r.status === 'abnormal').length,
      kinds: KINDS.map((kind) => {
        const list = all.filter((r) => r.kind === kind);
        return {
          kind,
          count: list.length,
          abnormalCount: list.filter((r) => r.status === 'abnormal').length,
          inactiveCount: list.filter((r) => r.status === 'inactive').length,
          balanceCents: sum(list.filter((r) => r.status !== 'inactive')),
        };
      }),
      recent: [...all].reverse().slice(0, 12).map((r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, bank: r.bank, owner: r.owner, accountNo: accountNo(r), balanceCents: cents(r) })),
    };
  }
}
