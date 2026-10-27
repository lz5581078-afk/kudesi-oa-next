import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Department, Position, User } from '../entities';
import { OrgAdminService } from './org-admin.service';

/** 员工 CSV 的列（导出和导入一致）。导入只改填了值的列，没填的保持原样。 */
export const STAFF_CSV_COLUMNS = ['姓名', '登录账号', '部门', '岗位', '直属上级', '职称', '用工类型', '计薪方式', '月薪(元)', '时薪(元)', '状态'] as const;
const EMPLOYMENT: Record<string, 'regular' | 'part_time' | 'temp'> = { 正式员工: 'regular', 正式: 'regular', 兼职: 'part_time', 临时工: 'temp', 临时: 'temp' };
const EMPLOYMENT_LABEL = { regular: '正式员工', part_time: '兼职', temp: '临时工' };
const PAY: Record<string, 'monthly' | 'hourly'> = { 月薪: 'monthly', 时薪: 'hourly' };

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const yuanToCents = (s: string) => (/^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : null);

export interface StaffImportRow { line: number; name: string; account: string; action: 'create' | 'update' | 'skip' | 'error'; message: string; initialPassword?: string }

@Injectable()
export class StaffImportService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly admin: OrgAdminService) {}

  /** 导出：薪资两列只有 org.staff.salary 权限的人才有内容。 */
  async exportCsv(actor: AuthUser): Promise<string> {
    const em = this.ds.manager;
    const [users, depts, positions] = await Promise.all([
      em.find(User, { where: { companyId: actor.companyId }, order: { id: 'ASC' } }),
      em.find(Department, { where: { companyId: actor.companyId } }),
      em.find(Position, { where: { companyId: actor.companyId } }),
    ]);
    const dn = new Map(depts.map((d) => [d.id, d.name])), pn = new Map(positions.map((p) => [p.id, p.name])), un = new Map(users.map((u) => [u.id, u.name]));
    const sal = createChecker(actor.permissions)('org.staff.salary');
    const lines = [STAFF_CSV_COLUMNS.join(',')];
    for (const u of users) {
      lines.push([
        u.name, u.account ?? '', u.departmentId ? dn.get(u.departmentId) : '', u.positionId ? pn.get(u.positionId) : '', u.managerId ? un.get(u.managerId) : '', u.title ?? '',
        EMPLOYMENT_LABEL[u.employmentType] ?? '', u.payType === 'hourly' ? '时薪' : '月薪',
        sal && u.baseSalary != null ? (u.baseSalary / 100).toFixed(2) : '', sal && u.hourlyRate != null ? (u.hourlyRate / 100).toFixed(2) : '',
        u.status === 'active' ? '在职' : '已停用',
      ].map(esc).join(','));
    }
    return `﻿${lines.join('\r\n')}\r\n`;
  }

  /**
   * 导入：按登录账号匹配（没有账号列值时按姓名，重名拒绝）。账号和姓名都对不上就新建，新建必须有登录账号。
   * dryRun 只检查不写入；真正导入时每行独立成功/失败，新账号的初始密码只在这次返回里出现。状态列只导出，不在这里改（停用要走交接）。
   */
  async importCsv(actor: AuthUser, text: string, dryRun: boolean) {
    const table = parseCsv(text);
    if (table.length < 2) return { dryRun, rows: [] as StaffImportRow[], summary: { create: 0, update: 0, skip: 0, error: 0 }, error: '文件里没有数据行' };
    const header = table[0].map((h) => h.trim());
    const col = (n: string) => header.indexOf(n);
    if (col('姓名') < 0 && col('登录账号') < 0) return { dryRun, rows: [], summary: { create: 0, update: 0, skip: 0, error: 0 }, error: '表头里至少要有“姓名”或“登录账号”列' };
    const em = this.ds.manager;
    const [users, depts, positions] = await Promise.all([
      em.find(User, { where: { companyId: actor.companyId } }), em.find(Department, { where: { companyId: actor.companyId, isSystem: false } }), em.find(Position, { where: { companyId: actor.companyId } }),
    ]);
    const can = createChecker(actor.permissions);
    const sal = can('org.staff.salary'), canEdit = can('org.staff.edit');
    const rows: StaffImportRow[] = [];
    const one = <T extends { id: number; name: string }>(list: T[], name: string, what: string): { id: number | null; err?: string } => {
      const hit = list.filter((x) => x.name === name);
      if (hit.length === 1) return { id: hit[0].id };
      return { id: null, err: hit.length === 0 ? `${what}「${name}」不存在` : `${what}「${name}」有重名` };
    };
    for (let i = 1; i < table.length; i++) {
      const cells = table[i];
      const get = (n: string) => (col(n) >= 0 ? (cells[col(n)] ?? '').trim() : '');
      const name = get('姓名'), account = get('登录账号');
      const r: StaffImportRow = { line: i + 1, name, account, action: 'skip', message: '' };
      rows.push(r);
      try {
        const byAccount = account ? users.find((u) => u.account === account) : undefined;
        const byName = !byAccount && !account && name ? users.filter((u) => u.name === name) : [];
        if (byName.length > 1) { r.action = 'error'; r.message = `姓名「${name}」有重名，请填登录账号`; continue; }
        const target = byAccount ?? byName[0];
        const input: Record<string, unknown> = {};
        const dept = get('部门'), pos = get('岗位'), mgr = get('直属上级');
        if (dept) { const m = one(depts, dept, '部门'); if (m.err) throw new Error(m.err); input.departmentId = m.id; }
        if (pos) { const m = one(positions, pos, '岗位'); if (m.err) throw new Error(m.err); input.positionId = m.id; }
        if (mgr) { const m = one(users, mgr, '直属上级'); if (m.err) throw new Error(m.err); input.managerId = m.id; }
        if (get('职称')) input.title = get('职称');
        if (get('用工类型')) { const v = EMPLOYMENT[get('用工类型')]; if (!v) throw new Error('用工类型只能是 正式员工/兼职/临时工'); input.employmentType = v; }
        const wantsPay = get('计薪方式') || get('月薪(元)') || get('时薪(元)');
        if (wantsPay && !sal) throw new Error('没有设置薪资的权限，请清空计薪方式、月薪、时薪三列');
        if (get('计薪方式')) { const v = PAY[get('计薪方式')]; if (!v) throw new Error('计薪方式只能是 月薪/时薪'); input.payType = v; }
        if (get('月薪(元)')) { const v = yuanToCents(get('月薪(元)')); if (v === null) throw new Error('月薪请填金额，最多两位小数'); input.baseSalary = v; }
        if (get('时薪(元)')) { const v = yuanToCents(get('时薪(元)')); if (v === null) throw new Error('时薪请填金额，最多两位小数'); input.hourlyRate = v; }
        if (target) {
          if (Object.keys(input).length === 0) { r.action = 'skip'; r.message = '没有要修改的内容'; continue; }
          if (!canEdit) throw new Error('没有修改员工的权限（org.staff.edit）');
          r.action = 'update'; r.message = `修改：${Object.keys(input).length} 项`;
          if (!dryRun) await this.admin.updateStaff(actor, target.id, input);
        } else {
          if (!account) throw new Error('新增员工必须填写登录账号');
          if (!name) throw new Error('新增员工必须填写姓名');
          r.action = 'create'; r.message = '新增员工';
          if (!dryRun) {
            const created = await this.admin.createStaff(actor, { account, name, ...input });
            r.initialPassword = created.initialPassword;
            users.push(await em.findOneByOrFail(User, { id: created.staff.id })); // 同一份文件里后面的人可以把他当上级、也防重复账号
          } else if (users.some((u) => u.account === account)) throw new Error('账号已存在');
        }
      } catch (e) {
        r.action = 'error'; r.message = (e as { message?: string }).message ?? '处理失败';
      }
    }
    const summary = { create: 0, update: 0, skip: 0, error: 0 };
    for (const r of rows) summary[r.action]++;
    return { dryRun, rows, summary };
  }
}
