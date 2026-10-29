import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('左侧目录就地新增商品分类不填分类码（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `x${crypto.randomBytes(5).toString('hex')}`, name: '自动码测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `ac${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('没填分类码时按名称首字母生成，重名的加数字；填了的仍然校验格式', async () => {
    const a = await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '纸箱' });
    expect(String(a.data.code)).toMatch(/^[A-Z0-9]{1,8}$/);
    const b = await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '纸箱子' });
    expect(b.data.code).not.toBe(a.data.code);
    const c = await svc.create(boss, 'finance-categories', { archiveType: 'package', name: '胶带', parentId: a.id });
    expect(String(c.data.code)).toMatch(/^[A-Z0-9]{1,8}$/);
    await expect(svc.create(boss, 'finance-categories', { archiveType: 'package', name: '坏码', code: 'bad-code' })).rejects.toThrow('分类码只能是');
  });
});
