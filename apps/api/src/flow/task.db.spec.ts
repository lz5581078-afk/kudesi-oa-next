/** 任务中心的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npx jest task */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Notification, User, WorkItem } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';
import { TaskService } from './task.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('任务中心（真实数据库）', () => {
  let ds: DataSource, tasks: TaskService, flow: FlowService;
  let admin: AuthUser, boss: AuthUser, worker: AuthUser, other: AuthUser;
  const mk = async (cid: number, account: string, name: string, admin_ = false) => (await ds.manager.save(User, ds.manager.create(User, { companyId: cid, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, isCompanyAdmin: admin_ }))).id;
  const au = (id: number, cid: number, name: string, allow: string[]): AuthUser => ({ id, companyId: cid, name, permissions: { isCompanyAdmin: false, allow: ['workbench.tasks.view', ...allow], deny: [] } });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    tasks = new TaskService(ds);
    flow = new FlowService(ds, buildServices(ds).resources, new FinanceDocumentsService(ds));
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `t${crypto.randomBytes(5).toString('hex')}`, name: '任务测试', status: 'active' }));
    const a = await mk(c.id, 'admin', '管理员', true);
    admin = { id: a, companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    boss = au(await mk(c.id, 'boss', '主管'), c.id, '主管', ['tasks.assign', 'tasks.routines.manage']);
    worker = au(await mk(c.id, 'w', '员工'), c.id, '员工', []);
    other = au(await mk(c.id, 'o', '别人'), c.id, '别人', []);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('给自己建任务不需要指派权限；指派别人要权限；只有负责人能完成；指派人收到完成通知', async () => {
    const mine = await tasks.create(worker, { title: '整理仓库', dueDate: '2099-01-01' });
    await expect(tasks.create(worker, { title: '让别人干', assigneeId: other.id })).rejects.toThrow(/权限/);
    await expect(tasks.create(worker, { title: '过去', dueDate: '2000-01-01' })).rejects.toThrow(/不能早于今天/);
    const t = await tasks.create(boss, { title: '盘点库存', description: '按仓库盘', assigneeId: worker.id });
    expect((await flow.notifications(worker, true)).items.some((n) => n.title.includes('盘点库存'))).toBe(true);
    const todo = await flow.todos(worker, { tab: 'pending', page: 1, pageSize: 20 });
    expect(todo.rows.find((r: { id: number }) => r.id === t.id)).toMatchObject({ templateLabel: '任务', runTitle: '盘点库存', requesterName: '主管' });
    await expect(tasks.complete(other, t.id)).rejects.toThrow(/负责人/);
    await expect(tasks.complete(worker, 999999)).rejects.toThrow(/不存在/);
    await tasks.complete(worker, t.id, '已盘完');
    await expect(tasks.complete(worker, t.id)).rejects.toThrow(/已经结束/);
    expect((await flow.notifications(boss, true)).items.some((n) => n.kind === 'result' && n.title.includes('盘点库存'))).toBe(true);
    expect((await tasks.assigned(boss, { page: 1, pageSize: 20 })).rows[0]).toMatchObject({ title: '盘点库存', status: 'done', doneNote: '已盘完', assigneeName: '员工' });
    // 取消：指派人可以，负责人（非指派人）不行
    await expect(tasks.cancel(other, mine.id)).rejects.toThrow(/指派人或管理员/);
    await tasks.cancel(worker, mine.id);
    const done = await flow.todos(worker, { tab: 'done', page: 1, pageSize: 20 });
    expect(done.rows.map((r: { runTitle: string }) => r.runTitle)).toContain('盘点库存');
  });

  it('周期任务：校验、权限、按日期生成且重复生成不重复；停用的不生成；负责人停用则跳过', async () => {
    await expect(tasks.saveRoutine(worker, null, { title: '日报', assigneeId: worker.id, frequency: 'daily', dueDays: 1 })).rejects.toThrow(/权限/);
    await expect(tasks.saveRoutine(boss, null, { title: '对账', assigneeId: worker.id, frequency: 'monthly', monthDay: 31, dueDays: 1 })).rejects.toThrow(/1 到 28/);
    const daily = await tasks.saveRoutine(boss, null, { title: '检查库存', assigneeId: worker.id, frequency: 'daily', dueDays: 1 });
    const weekly = await tasks.saveRoutine(boss, null, { title: '周盘点', assigneeId: worker.id, frequency: 'weekly', weekday: 1, dueDays: 2 });
    const off = await tasks.saveRoutine(boss, null, { title: '停用的', assigneeId: worker.id, frequency: 'daily', dueDays: 1 });
    await tasks.setRoutineActive(boss, off.id, false);
    const gone = await mkGone();
    await tasks.saveRoutine(boss, null, { title: '没人办', assigneeId: gone, frequency: 'daily', dueDays: 1 });
    await ds.manager.update(User, { id: gone }, { status: 'disabled' } as never);

    const count = (title: string) => ds.manager.count(WorkItem, { where: { companyId: admin.companyId, title } });
    await tasks.generateRoutines('2026-10-26'); // 周一
    await tasks.generateRoutines('2026-10-26'); // 重复调用不重复
    expect(await count('检查库存')).toBe(1);
    expect(await count('周盘点')).toBe(1);
    expect(await count('停用的')).toBe(0);
    expect(await count('没人办')).toBe(0);
    await tasks.generateRoutines('2026-10-27'); // 周二：只有每天的
    expect(await count('检查库存')).toBe(2);
    expect(await count('周盘点')).toBe(1);
    const w = await ds.manager.findOneByOrFail(WorkItem, { companyId: admin.companyId, title: '周盘点' });
    expect(w.dueAt?.toISOString()).toBe('2026-10-27T15:59:59.000Z'); // 周一起 2 天：周二 23:59:59（北京）
    expect(w.routineId).toBe(weekly.id);
    expect(await ds.manager.count(Notification, { where: { userId: worker.id, kind: 'task' } })).toBeGreaterThan(2);
    expect(daily.id).toBeGreaterThan(0);
    expect((await tasks.routines(boss)).length).toBe(4);
    // 周期任务生成的待办：管理员或有周期任务权限者可取消
    await expect(tasks.cancel(other, w.id)).rejects.toThrow(/指派人或管理员/);
    await tasks.cancel(admin, w.id);
  });

  it('监督与复核：按反馈模板提交，待复核，监督人通过或退回；周期任务把监督设置带到生成的任务', async () => {
    const t = await tasks.create(boss, { title: '日报', assigneeId: worker.id, supervisorId: other.id, requiresReview: true, feedbackPreset: 'operation_daily', completionStandard: '填完整' });
    await expect(tasks.create(boss, { title: 'x', feedbackPreset: 'nope' })).rejects.toThrow(/反馈模板/);
    await expect(tasks.create(boss, { title: 'x', supervisorId: 999999 })).rejects.toThrow(/监督人/);
    await expect(tasks.complete(worker, t.id, '好了')).rejects.toThrow(/至少填写/);
    await expect(tasks.complete(worker, t.id, '', { payload: { salesAmount: 'abc' } })).rejects.toThrow(/数字/);
    expect(await tasks.complete(worker, t.id, '', { payload: { salesAmount: '100.5', todayActions: '上新' } })).toMatchObject({ status: 'reviewing' });
    await expect(tasks.complete(worker, t.id, '再交')).rejects.toThrow(/等监督人处理/);
    const todo = await flow.todos(other, { tab: 'pending', page: 1, pageSize: 20 });
    expect(todo.counts.taskReview).toBe(1);
    await expect(tasks.review(worker, t.id, { action: 'approve' })).rejects.toThrow(/监督人或指派人/);
    await expect(tasks.review(other, t.id, { action: 'return' })).rejects.toThrow(/原因/);
    await tasks.review(other, t.id, { action: 'return', comment: '推广费没填' });
    expect((await tasks.supervised(other, { status: 'open', page: 1, pageSize: 20 })).rows[0]).toMatchObject({ title: '日报', reviewNote: '推广费没填', supervisorName: '别人' });
    await tasks.complete(worker, t.id, '', { payload: { salesAmount: '100', promotionFee: '10' } });
    await tasks.review(other, t.id, { action: 'approve' });
    expect((await tasks.assigned(boss, { status: 'done', page: 1, pageSize: 50 })).rows.find((r: { id: number }) => r.id === t.id)).toMatchObject({ submitPayload: { salesAmount: '100', promotionFee: '10' } });

    // 异常提交：必须写说明，监督人（没有时是指派人）处理
    const a = await tasks.create(boss, { title: '查手机号', assigneeId: worker.id });
    await expect(tasks.complete(worker, a.id, '', { abnormal: true })).rejects.toThrow(/异常提交要写/);
    expect(await tasks.complete(worker, a.id, '号码停机', { abnormal: true })).toMatchObject({ status: 'abnormal' });
    expect((await tasks.reviewCounts(admin.companyId, boss.id)).review).toBe(1);
    await tasks.review(boss, a.id, { action: 'approve', comment: '已知晓' });

    const r = await tasks.saveRoutine(boss, null, { title: '周期复核', assigneeId: worker.id, frequency: 'daily', dueDays: 1, supervisorId: other.id, requiresReview: true, feedbackPreset: 'simple' });
    await expect(tasks.saveRoutine(boss, null, { title: '没监督', assigneeId: worker.id, frequency: 'daily', dueDays: 1, requiresReview: true })).rejects.toThrow(/监督人/);
    await tasks.generateRoutines('2026-11-03');
    const w = await ds.manager.findOneByOrFail(WorkItem, { routineId: r.id, companyId: admin.companyId });
    expect(w).toMatchObject({ supervisorId: other.id, requiresReview: true, feedbackPreset: 'simple' });
  });

  it('延期申请：负责人申请，监督人同意后截止时间改变；不同意要写原因；同时只能有一条', async () => {
    const t = await tasks.create(boss, { title: '要延期', assigneeId: worker.id, dueDate: '2099-01-01' });
    await expect(tasks.requestDelay(other, t.id, { dueDate: '2099-02-01', reason: '忙' })).rejects.toThrow(/负责人/);
    await expect(tasks.requestDelay(worker, t.id, { dueDate: '2099-02-01', reason: '' })).rejects.toThrow(/原因/);
    await expect(tasks.requestDelay(worker, t.id, { dueDate: '2098-12-01', reason: '忙' })).rejects.toThrow(/晚于/);
    const d = await tasks.requestDelay(worker, t.id, { dueDate: '2099-02-01', reason: '供应商没发货' });
    await expect(tasks.requestDelay(worker, t.id, { dueDate: '2099-03-01', reason: '再来' })).rejects.toThrow(/已经有一条/);
    expect((await tasks.assigned(boss, { page: 1, pageSize: 50 })).rows.find((r: { id: number }) => r.id === t.id)).toMatchObject({ delayId: d.id, delayReason: '供应商没发货' });
    await expect(tasks.decideDelay(other, d.id, { approve: true })).rejects.toThrow(/监督人或指派人/);
    await expect(tasks.decideDelay(boss, d.id, { approve: false })).rejects.toThrow(/原因/);
    await tasks.decideDelay(boss, d.id, { approve: true });
    await expect(tasks.decideDelay(boss, d.id, { approve: true })).rejects.toThrow(/处理过/);
    expect((await ds.manager.findOneByOrFail(WorkItem, { id: t.id })).dueAt?.toISOString()).toBe('2099-02-01T15:59:59.000Z');
    // 没有指派人也没有监督人的周期任务不能申请延期
    const x = await tasks.saveRoutine(boss, null, { title: '无监督周期', assigneeId: worker.id, frequency: 'daily', dueDays: 1 });
    await tasks.generateRoutines('2026-11-04');
    const w = await ds.manager.findOneByOrFail(WorkItem, { routineId: x.id, companyId: admin.companyId });
    await expect(tasks.requestDelay(worker, w.id, { dueDate: '2099-01-01', reason: '忙' })).rejects.toThrow(/没有监督人/);
  });

  async function mkGone() { return mk(admin.companyId, `gone${crypto.randomBytes(3).toString('hex')}`, '离职员工'); }
});
