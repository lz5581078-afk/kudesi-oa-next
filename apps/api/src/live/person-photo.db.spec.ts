import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { AuthUser } from '../common/auth.decorators';
import {
  Company,
  Position,
  ResourceFile,
  ResourceRecord,
  User,
} from '../entities';
import { buildServices } from '../test-support';
import { PhoneUploadService } from '../integrations/phone-upload.service';
import { LivePersonPhotoService } from './person-photo.controller';
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const image = { originalname: '人员照片.png', buffer: PNG, size: PNG.length };
d('人员照与直播姓名受控读取（真实MySQL）', () => {
  let ds: DataSource,
    s: ReturnType<typeof buildServices>,
    phone: PhoneUploadService,
    photos: LivePersonPhotoService,
    boss: AuthUser,
    viewer: AuthUser,
    foreign: AuthUser,
    personId: number,
    recordId: number;
  const tag = randomBytes(4).toString('hex');
  const actor = (u: User, admin = false, allow: string[] = []): AuthUser => ({
    id: u.id,
    companyId: u.companyId,
    name: u.name,
    permissions: { isCompanyAdmin: admin, allow, deny: [] },
  });
  beforeAll(async () => {
    ds = await new DataSource({
      ...buildDataSourceOptions({
        ...process.env,
        DB_NAME: process.env.TEST_DB_NAME,
      }),
      migrationsRun: true,
    } as never).initialize();
    s = buildServices(ds);
    phone = new PhoneUploadService(ds, s.files);
    photos = new LivePersonPhotoService(ds, s.files);
    const c = await ds.manager.save(Company, {
        code: `photo${tag}`,
        name: '照片测试',
        status: 'active',
      }),
      f = await ds.manager.save(Company, {
        code: `photoForeign${tag}`,
        name: '其他公司照片',
        status: 'active',
      });
    const mk = (companyId: number, name: string, admin = false) =>
      ds.manager.save(User, {
        companyId,
        name,
        account: `photo${name}${tag}`,
        passwordHash: 'x',
        status: 'active',
        isCompanyAdmin: admin,
      });
    boss = actor(await mk(c.id, '老板', true), true);
    viewer = actor(await mk(c.id, '直播查看'), false, ['features.live.view']);
    foreign = actor(await mk(f.id, '外公司', true), true);
    const pos = await ds.manager.save(Position, {
      companyId: c.id,
      name: '主播',
      workspaceType: 'live_anchor',
    });
    const u = await mk(c.id, '同名主播');
    personId = u.id;
    await ds.manager.update(User, u.id, { positionId: pos.id });
    const rec = await s.resources.create(boss, 'workforce', {
      userId: u.id,
      employmentType: 'part_time',
      contractStartDate: '2026-01-01',
      payMethod: 'daily',
    });
    recordId = rec.id;
    await s.settings.saveQiniu(boss, {
      accessKey: 'TEST-AK',
      secretKey: 'TEST-SK',
      bucket: 'test',
      zone: 'z0',
      domain: 'https://test.invalid',
      isPrivate: true,
    });
  }, 120000);
  afterAll(async () => {
    await ds?.destroy();
  });
  it('人员照片只接受图片，最多一张；只存对应字段，保存后才可总览读取', async () => {
    expect((await photos.photo(boss, personId))).toMatchObject({ photo: null, upload: { recordId } });
    expect((await photos.photo(viewer, personId))).not.toHaveProperty('upload');
    await expect(
      s.files.upload(boss, 'workforce', 'photo', {
        originalname: 'x.pdf',
        buffer: Buffer.from('%PDF-test'),
        size: 9,
      }),
    ).rejects.toThrow(/图片/);
    const file = await s.files.upload(boss, 'workforce', 'photo', image);
    expect((await photos.photo(viewer, personId)).photo).toBeNull();
    await s.resources.update(boss, 'workforce', recordId, { photo: [file.id] });
    const dto = await s.resources.get(boss, 'workforce', recordId);
    expect(dto.data.photo).toEqual([file.id]);
    expect(dto.files[file.id]).toMatchObject({ mime: 'image/png' });
    const shown = await photos.photo(viewer, personId);
    expect(shown).not.toHaveProperty('upload');
    expect(shown.photo).toMatchObject({ expiresIn: 300, mime: 'image/png' });
    await expect(s.files.url(viewer, file.id)).rejects.toThrow(/权限/);
    const other = await s.files.upload(boss, 'workforce', 'photo', image);
    await expect(
      s.resources.update(boss, 'workforce', recordId, {
        photo: [file.id, other.id],
      }),
    ).rejects.toThrow(/最多|文件/);
  });
  it('扫码上传返回裁剪要求，最多一次；照片在电脑保存时绑定，不公开人员或其他资料', async () => {
    const session = await phone.create(boss, 'workforce', 'photo');
    expect(session.maxUploads).toBe(1);
    const info = await phone.inspect(session.token);
    expect(info).toMatchObject({
      label: '人员照片',
      imageCrop: 'square',
      remaining: 1,
    });
    expect(info).not.toHaveProperty('userId');
    await phone.upload(session.token, image);
    await expect(phone.upload(session.token, image)).rejects.toThrow(/次数/);
    const status = await phone.status(boss, session.id);
    expect(status.files).toHaveLength(1);
    await expect(phone.status(foreign, session.id)).rejects.toThrow(/不存在/);
    const file = status.files[0];
    expect(
      (await ds.manager.findOneByOrFail(ResourceFile, { id: file.id }))
        .resourceId,
    ).toBeNull();
    await s.resources.update(boss, 'workforce', recordId, { photo: [file.id] });
    expect(
      (await ds.manager.findOneByOrFail(ResourceFile, { id: file.id }))
        .resourceId,
    ).toBe(recordId);
  });
  it('只能按员工编号读取本公司主播；同名不串图，普通权限和跨公司请求被拒', async () => {
    await expect(photos.photo(foreign, personId)).rejects.toThrow(/不存在/);
    await expect(
      photos.photo(
        {
          ...viewer,
          permissions: { isCompanyAdmin: false, allow: [], deny: [] },
        },
        personId,
      ),
    ).rejects.toThrow(/权限/);
    const [person] = await ds.query(
      'SELECT position_id FROM users WHERE company_id=? AND id=?',
      [boss.companyId, personId],
    );
    const second = await ds.manager.save(User, {
      companyId: boss.companyId,
      name: '同名主播',
      account: `same${tag}`,
      passwordHash: 'x',
      status: 'active',
      positionId: person.position_id,
    });
    expect((await photos.photo(viewer, second.id)).photo).toBeNull();
    expect((await photos.photo(viewer, personId)).photo).not.toBeNull();
    await expect(photos.photo(viewer, boss.id)).rejects.toThrow(/主播不存在/);
  });
  it('档案/字段/绑定不匹配的文件及归档照片不能通过总览读取', async () => {
    const original = (
      await ds.manager.findOneByOrFail(ResourceRecord, {
        id: recordId,
        companyId: boss.companyId,
      })
    ).data.photo as number[];
    const file = await s.files.upload(
      boss,
      'workforce',
      'identityFiles',
      image,
    );
    await ds.manager.update(
      ResourceRecord,
      { id: recordId, companyId: boss.companyId },
      { data: { userId: personId, photo: [file.id] } },
    );
    expect((await photos.photo(viewer, personId)).photo).toBeNull();
    await ds.manager.update(
      ResourceRecord,
      { id: recordId, companyId: boss.companyId },
      { data: { userId: personId, photo: original } },
    );
    expect((await photos.photo(viewer, personId)).photo).not.toBeNull();
    await ds.manager.update(
      ResourceRecord,
      { id: recordId, companyId: boss.companyId },
      { archivedAt: new Date() },
    );
    expect((await photos.photo(viewer, personId)).photo).toBeNull();
  });
});
