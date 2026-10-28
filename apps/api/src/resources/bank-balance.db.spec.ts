import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('银行账户：当前余额与公户详情读时现算（真实数据库）', () => {
  let ds: DataSource, svc: ResourcesService, boss: AuthUser;
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `x${crypto.randomBytes(5).toString('hex')}`, name: '余额公司', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `bb${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('当前余额 = 期初 + 现金银行流水（整数分）；只读，提交的值被忽略；公户详情看客户号等是否维护', async () => {
    const a = await svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '余额户', bank: '测试银行', accountNo: '6222000011112222', balance: 1000, customerNo: 'C001' });
    const b = await svc.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '空户', bank: '测试银行', accountNo: '6222000011113333' });
    const p = await svc.create(boss, 'bank-accounts', { kind: 'company_card', accountName: '公司卡', bank: '测试银行', accountNo: '6222000011114444' });
    const doc = (await ds.query(`INSERT INTO finance_documents (company_id, doc_no, doc_type, status, doc_date, amount_cents, offset_cents, created_by) VALUES (?,?,?,?,?,?,?,?)`, [boss.companyId, `T${crypto.randomBytes(5).toString('hex')}`, 'receipt', 'posted', '2026-03-01', 0, 0, boss.id])).insertId as number;
    await ds.query(`INSERT INTO finance_entries (company_id, document_id, entry_date, kind, account_id, sub_id, amount_cents) VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?),(?,?,?,?,?,?,?)`,
      [boss.companyId, doc, '2026-03-01', 'bank', a.id, 0, 25050, boss.companyId, doc, '2026-03-02', 'bank', a.id, 0, -5000, boss.companyId, doc, '2026-03-02', 'cash', a.id, 0, 99999]);
    const got = await svc.get(boss, 'bank-accounts', a.id);
    expect(got.data.currentBalance).toBe(1000 + 25050 - 5000);
    expect(got.data.publicInfoFlag).toBe('yes');
    const edited = await svc.update(boss, 'bank-accounts', a.id, { currentBalance: 1 });
    expect(edited.data.currentBalance).toBe(1000 + 25050 - 5000);
    const list = (await svc.list(boss, 'bank-accounts', { page: 1, pageSize: 50 })).items;
    expect(list.find((x) => x.id === b.id)!.data).toMatchObject({ currentBalance: 0, publicInfoFlag: 'no' });
    expect(list.find((x) => x.id === p.id)!.data.publicInfoFlag).toBeUndefined();
  });
});
