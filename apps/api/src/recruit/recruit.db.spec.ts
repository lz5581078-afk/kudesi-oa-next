import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { emptyRecruitForm, isValidIdNo, normalizeRecruitForm, recruitFormProblems, type RecruitForm } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { Company, Department, Position, User } from '../entities';
import { OcrService } from '../integrations/ocr.service';
import { RecruitService } from './recruit.service';

describe('招聘登记表规则', () => {
  it('身份证校验位与学历写法', () => {
    expect(isValidIdNo('11010519491231002X')).toBe(true);
    expect(isValidIdNo('110105194912310021')).toBe(false);
    expect(normalizeRecruitForm({ education: '大学本科', ethnicity: '汉', birthDate: '1995年3月8日', gender: '未知' })).toMatchObject({ education: '本科', ethnicity: '汉族', birthDate: '1995-03-08', gender: '' });
  });
  it('必填项缺失给出人话提示', () => {
    expect(recruitFormProblems(emptyRecruitForm())).toEqual(expect.arrayContaining(['请填写姓名', '请填写身份证号码']));
  });
});

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('招聘管理：真实 MySQL', () => {
  let ds: DataSource, svc: RecruitService, hr: AuthUser, other: AuthUser, outsider: AuthUser;
  const crypto = new CryptoService({ test: Buffer.alloc(32, 9) }, 'test');
  const form = (extra: Partial<RecruitForm> = {}): RecruitForm => ({ ...emptyRecruitForm('招聘网站'), name: '张三', gender: '男', birthDate: '1990-05-01', education: '本科', phone: '13800138000', idNo: '11010519491231002X', ...extra });
  const mkUser = async (companyId: number, name: string, departmentId: number | null, admin = false) => {
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId, name, account: randomBytes(8).toString('hex'), passwordHash: 'x', status: 'active', isCompanyAdmin: admin, departmentId } as never));
    return u;
  };
  const actor = (u: User, perms: string[] = [], admin = false) => ({ id: u.id, companyId: u.companyId, name: u.name, permissions: { isCompanyAdmin: admin, allow: perms, deny: [] } }) as AuthUser;
  const fakeOcr = { recognizeResume: async (_c: number, file: unknown) => { if (!file) throw new Error('没有收到图片'); return { form: form({ sourceChannel: '' }), filled: 9 }; } } as unknown as OcrService;
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true } as never);
    await ds.initialize();
    svc = new RecruitService(ds, crypto, fakeOcr);
    const mkCompany = (n: string) => ds.manager.save(Company, ds.manager.create(Company, { code: randomBytes(8).toString('hex'), name: n, status: 'active' }));
    const c = await mkCompany('招聘测试'), c2 = await mkCompany('他司');
    const hrDept = await ds.manager.save(Department, ds.manager.create(Department, { companyId: c.id, name: '人事', status: 'active', sortOrder: 0 }));
    const gmDept = await ds.manager.save(Department, ds.manager.create(Department, { companyId: c.id, name: '总经办', status: 'active', sortOrder: 1 }));
    const hrUser = await mkUser(c.id, '小人事', hrDept.id), gm = await mkUser(c.id, '总经理', gmDept.id), stranger = await mkUser(c.id, '路人', null);
    const hr2 = await mkUser(c.id, '二号人事', hrDept.id);
    hr = actor(hrUser, ['features.recruit.view', 'recruit.manage', 'recruit.id.view']);
    other = actor(hr2, ['features.recruit.view', 'recruit.manage']);
    const o = await mkUser(c2.id, '他司人事', null);
    outsider = actor(o, ['features.recruit.view', 'recruit.manage', 'recruit.id.view']);
    (global as Record<string, unknown>).__recruit = { gm: gm.id, stranger: stranger.id, hr2: hr2.id };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('二维码：只存摘要，生成后可再次取回；停用后不可用', async () => {
    const { token } = await svc.createInvite(hr, { label: '门店', channel: '路过门店' });
    expect((await svc.preview(token)).channel).toBe('路过门店');
    expect((await svc.listInvites(hr)).find((i: { label: string }) => i.label === '门店')?.token).toBe(token);
    expect((await svc.listInvites(actor({ id: hr.id, companyId: hr.companyId } as User, ['features.recruit.view']))).find((i: { label: string }) => i.label === '门店')?.token).toBeNull();
    await expect(svc.createInvite(actor({ id: hr.id, companyId: hr.companyId } as User, ['features.recruit.view']), { label: 'x' })).rejects.toThrow('没有招聘管理权限');
    const id = (await svc.listInvites(hr)).find((i: { label: string }) => i.label === '门店')!.id;
    await svc.revokeInvite(hr, id);
    await expect(svc.preview(token)).rejects.toThrow('已失效');
    await expect(svc.preview('bad')).rejects.toThrow('无效');
  });

  it('提交：身份证加密存储、重复提交幂等、人事和总经办收到通知、他司看不到', async () => {
    const { token } = await svc.createInvite(hr, { label: '网站' });
    const key = randomUUID();
    const r1 = await svc.submit(token, key, 'manual', form());
    const r2 = await svc.submit(token, key, 'manual', form());
    expect(r2.id).toBe(r1.id);
    const [raw] = await ds.query('SELECT id_no_enc, id_no_masked FROM recruit_applications WHERE id=?', [r1.id]);
    expect(raw.id_no_enc).not.toContain('11010519491231002X');
    expect(raw.id_no_masked).toBe('110105********002X');
    const notes = await ds.query("SELECT user_id, body FROM notifications WHERE company_id=? AND kind='recruit'", [hr.companyId]);
    const ids = notes.map((n: { user_id: number }) => n.user_id).sort();
    const g = (global as unknown as Record<string, { gm: number; stranger: number; hr2: number }>).__recruit;
    expect(ids).toEqual([hr.id, g.hr2, g.gm].sort());
    expect(JSON.stringify(notes)).not.toContain('11010519491231002X');
    await expect(svc.submit(token, randomUUID(), 'manual', form({ idNo: '110105194912310021' }))).rejects.toThrow('身份证号码不正确');
    await expect(svc.getApplication(outsider, r1.id)).rejects.toThrow('没有这位求职者');
    expect((await svc.listApplications(outsider, {})).total).toBe(0);
  });

  it('身份证明文要专门权限并留痕；认领只能一人；打印留痕；统计', async () => {
    const { token } = await svc.createInvite(hr, { label: '认领' });
    const { id } = await svc.submit(token, randomUUID(), 'image', form({ name: '李四', phone: '13900139000' }));
    expect((await svc.getApplication(other, id)).form.idNo).toBe('110105********002X');
    await expect(svc.revealId(other, id, 'view')).rejects.toThrow('没有查看身份证号的权限');
    expect((await svc.revealId(hr, id, 'print')).idNo).toBe('11010519491231002X');
    await svc.claim(hr, id);
    await svc.claim(hr, id);
    await expect(svc.claim(other, id)).rejects.toThrow('已经有同事在跟进');
    await svc.recordPrint(hr, id, true);
    const d = await svc.getApplication(hr, id);
    expect(d.handlerName).toBe('小人事');
    expect(d.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['submitted', 'claimed', 'printed', 'id_view']));
    expect((await svc.stats(hr)).handlers.find((h: { id: number }) => h.id === hr.id)).toMatchObject({ claimed: 1, printed: 1 });
    expect((await ds.query("SELECT COUNT(*) n FROM audit_logs WHERE company_id=? AND action='recruit.id.view'", [hr.companyId]))[0].n).toBe('1');
  });

  it('图片识别只返回待确认内容并带默认渠道', async () => {
    const { token } = await svc.createInvite(hr, { label: '识别', channel: '抖音/短视频' });
    const r = await svc.recognize(token, { buffer: Buffer.from('x'), size: 1 } as never);
    expect(r.form.sourceChannel).toBe('抖音/短视频');
    expect(r.filled).toBe(9);
    const invite = (await svc.listInvites(hr)).find((i: { label: string }) => i.label === '识别');
    expect(invite.applicationCount).toBe(0); // 识别不入库，等求职者确认提交
  });

  it('招聘岗位：从部门岗位导入、重复导入不重复；有在招岗位时必须选岗位并记名称快照', async () => {
    const [dept] = await ds.query('SELECT id FROM departments WHERE company_id=? LIMIT 1', [hr.companyId]);
    const pos = await ds.manager.save(Position, ds.manager.create(Position, { companyId: hr.companyId, departmentId: dept.id, name: '客服专员', status: 'active', workspaceType: 'blank' } as never));
    const foreign = await ds.manager.save(Position, ds.manager.create(Position, { companyId: outsider.companyId, name: '他司岗', status: 'active', workspaceType: 'blank' } as never));
    expect((await svc.positionCandidates(hr)).find((p: { id: number }) => p.id === pos.id)).toMatchObject({ name: '客服专员', imported: false });
    await expect(svc.importOpenings(hr, [foreign.id])).rejects.toThrow('不属于本公司');
    await expect(svc.importOpenings(other, [pos.id])).resolves.toMatchObject({ added: 1 });
    expect(await svc.importOpenings(hr, [pos.id])).toMatchObject({ added: 0, skipped: 1 });
    const opening = (await svc.listOpenings(hr)).find((o: { positionId: number }) => o.positionId === pos.id);
    const { token } = await svc.createInvite(hr, { label: '岗位' });
    expect((await svc.preview(token)).openings.map((o: { title: string }) => o.title)).toContain('客服专员');
    await expect(svc.submit(token, randomUUID(), 'manual', form())).rejects.toThrow('请选择应聘岗位');
    await expect(svc.submit(token, randomUUID(), 'manual', form(), 999999)).rejects.toThrow('请选择应聘岗位');
    const { id } = await svc.submit(token, randomUUID(), 'manual', form(), opening.id);
    expect((await svc.getApplication(hr, id)).openingTitle).toBe('客服专员');
    await svc.updateOpening(hr, opening.id, { status: 'closed' });
    await ds.query("UPDATE recruit_openings SET status='closed' WHERE company_id=?", [hr.companyId]);
    await expect(svc.submit(token, randomUUID(), 'manual', form(), opening.id)).resolves.toMatchObject({ ok: true }); // 没有在招岗位时不强制选岗
    const note = await ds.query("SELECT title FROM notifications WHERE company_id=? AND kind='recruit' AND title LIKE '%应聘客服专员%'", [hr.companyId]);
    expect(note.length).toBeGreaterThan(0);
  });
});
