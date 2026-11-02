import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { deskAccessPermissions } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, Department, Position, PositionPermission, User, UserPermissionOverride } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { DeskAccessService } from './desk-access.service';

const db = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
db('岗位功能批量授权（真实数据库）', () => {
  let ds: DataSource, svc: DeskAccessService;
  beforeAll(async () => { ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never); await ds.initialize(); svc = new DeskAccessService(ds); });
  afterAll(async () => { await ds?.destroy(); });
  async function fixture() {
    const tag = randomBytes(6).toString('hex');
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `desk-${tag}`, name: `岗位权限测试${tag}`, status: 'active' }));
    const department = async (name: string, parentId: number | null = null) => ds.manager.save(Department, ds.manager.create(Department, { companyId: company.id, name, parentId, status: 'active', sortOrder: 0 }));
    const hr = await department('人事部'), sub = await department('人事助理', hr.id), ops = await department('运营部');
    const position = async (name: string, departmentId: number, workspaceType: 'general' | 'operations' | 'finance') => ds.manager.save(Position, ds.manager.create(Position, { companyId: company.id, name, departmentId, workspaceType, level: 'staff', status: 'active', sortOrder: 0 }));
    const hp = await position('人事主管', sub.id, 'general'), op = await position('运营', ops.id, 'operations'), fp = await position('财务兼岗', ops.id, 'finance');
    const user = async (name: string, positionId: number | null, departmentId: number, isCompanyAdmin = false, extraPositionIds: number[] = []) => ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: `${tag}-${name}`, name, positionId, departmentId, isCompanyAdmin, extraPositionIds, status: 'active', passwordHash: 'test-only', mustChangePassword: false }));
    const admin = await user('admin', null, ops.id, true), hu = await user('hr', hp.id, hr.id), worker = await user('worker', op.id, ops.id, false, [fp.id]);
    for (const p of [hp, op, fp]) await ds.manager.save(PositionPermission, ds.manager.create(PositionPermission, { positionId: p.id, permission: p.id === hp.id ? 'live.manage' : 'finance.docs.post' }));
    for (const u of [hu, worker, admin]) await ds.manager.save(UserPermissionOverride, ds.manager.create(UserPermissionOverride, { userId: u.id, permission: 'system.integrations.view', effect: 'allow' }));
    const actor: AuthUser = { id: admin.id, companyId: company.id, name: admin.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    return { company, hp, op, fp, hu, worker, admin, actor };
  }
  it('只更新当前公司：人事及下级、个人覆盖、管理员不变；兼岗权限保留为岗位并集', async () => {
    const a = await fixture(), b = await fixture();
    const plan = await svc.preview(a.actor);
    expect(plan.positions.find((p) => p.id === a.hp.id)?.preserved).toBe(true);
    expect(plan.staff.find((u) => u.id === a.hu.id)?.preserved).toBe(true);
    await svc.apply(a.actor, plan.fingerprint);
    expect((await ds.manager.find(PositionPermission, { where: { positionId: a.hp.id } })).map((g) => g.permission)).toEqual(['live.manage']);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.hu.id } })).toBe(1);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.admin.id } })).toBe(1);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.worker.id } })).toBe(0);
    for (const p of [a.op, a.fp]) expect((await ds.manager.find(PositionPermission, { where: { positionId: p.id } })).map((g) => g.permission).sort()).toEqual(deskAccessPermissions(p.workspaceType, p.level));
    expect((await ds.manager.find(PositionPermission, { where: { positionId: b.op.id } })).map((g) => g.permission)).toEqual(['finance.docs.post']);
    const audit = await ds.manager.findOneByOrFail(AuditLog, { companyId: a.company.id, action: 'position.desk-permissions.apply' });
    expect((audit.detail as unknown as { fingerprint: string }).fingerprint).toBe(plan.fingerprint);
    const again = await svc.preview(a.actor); expect(again.changedPositions).toBe(0); expect(again.changedStaff).toBe(0);
  });
  it('非公司管理员不能预览或应用，伪造其他公司身份也不能读计划', async () => {
    const a = await fixture(), b = await fixture();
    const worker = { ...a.actor, id: a.worker.id, permissions: { isCompanyAdmin: false, allow: ['org.structure.edit'], deny: [] } };
    await expect(svc.preview(worker)).rejects.toThrow(/仅公司管理员/);
    await expect(svc.apply(worker, '0'.repeat(64))).rejects.toThrow(/仅公司管理员/);
    await expect(svc.preview({ ...a.actor, companyId: b.company.id })).rejects.toThrow(/仅公司管理员/);
  });
  it('预览后权限或岗位归属改变，拒绝旧计划且不覆盖新修改', async () => {
    const a = await fixture(), plan = await svc.preview(a.actor);
    await ds.manager.update(Position, { id: a.op.id }, { level: 'manager' });
    await expect(svc.apply(a.actor, plan.fingerprint)).rejects.toThrow(/重新预览/);
    expect((await ds.manager.find(PositionPermission, { where: { positionId: a.op.id } })).map((g) => g.permission)).toEqual(['finance.docs.post']);
  });
  it('人事员工兼任的非人事岗位也保留，个人拒绝不会被间接删除', async () => {
    const a = await fixture();
    await ds.manager.update(User, { id: a.hu.id }, { extraPositionIds: [a.fp.id] });
    await ds.manager.save(UserPermissionOverride, ds.manager.create(UserPermissionOverride, { userId: a.hu.id, permission: 'resource.stores.view', effect: 'deny' }));
    const plan = await svc.preview(a.actor); expect(plan.positions.find((p) => p.id === a.fp.id)?.preserved).toBe(true);
    await svc.apply(a.actor, plan.fingerprint);
    expect((await ds.manager.find(PositionPermission, { where: { positionId: a.fp.id } })).map((g) => g.permission)).toEqual(['finance.docs.post']);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.hu.id } })).toBe(2);
  });
  it('写审计失败时整批回滚，不产生半数岗位已更新的状态', async () => {
    const a = await fixture(), plan = await svc.preview(a.actor);
    // 强制事务最后一步失败，核对岗位和个人授权均回滚。
    const transaction = ds.transaction.bind(ds);
    const failing = new DeskAccessService({ transaction: (_isolation: unknown, fn: (em: unknown) => Promise<unknown>) => transaction('SERIALIZABLE', async (em) => {
      const originalSave = em.save.bind(em);
      const spy = jest.spyOn(em, 'save').mockImplementation(((target: unknown, ...args: unknown[]) => { if (target === AuditLog) throw new Error('audit unavailable'); return (originalSave as Function)(target, ...args); }) as never);
      try { return await fn(em); } finally { spy.mockRestore(); }
    }) } as unknown as DataSource);
    await expect(failing.apply(a.actor, plan.fingerprint)).rejects.toThrow('audit unavailable');
    expect((await ds.manager.find(PositionPermission, { where: { positionId: a.op.id } })).map((g) => g.permission)).toEqual(['finance.docs.post']);
    expect(await ds.manager.count(UserPermissionOverride, { where: { userId: a.worker.id } })).toBe(1);
  });
});
