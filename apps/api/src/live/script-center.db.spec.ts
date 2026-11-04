import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { buildServices } from '../test-support';
import { Company, User } from '../entities';
import { ScriptCenterController } from './script-center.controller';

(process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip)('话术中心真实数据库', () => {
  let ds: DataSource;
  afterAll(async () => {
    await ds?.destroy();
  });
  it('版本内命名素材、标注及冲突校验，隔离其他版本与公司', async () => {
    ds = await new DataSource({
      ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }),
      migrationsRun: true,
    } as never).initialize();
    const tag = randomUUID().slice(0, 8);
    const c = await ds.manager.save(Company, { code: 'script' + tag, name: '话术测试', status: 'active' });
    const user = await ds.manager.save(User, {
      companyId: c.id,
      account: 'editor' + tag,
      name: '编辑',
      passwordHash: 'x',
      status: 'active',
    });
    const actor = {
      id: user.id,
      companyId: c.id,
      name: user.name,
      permissions: { isCompanyAdmin: true, allow: [], deny: [] },
    };
    const services = buildServices(ds);
    await services.settings.saveQiniu(actor, {
      accessKey: 'test',
      secretKey: 'test',
      bucket: 'test',
      zone: 'z0',
      domain: 'https://test.invalid',
      isPrivate: true,
    });
    const api = new ScriptCenterController(ds, services.files);
    const folder = await api.folder(actor, { name: '花育25' });
    expect(await api.pondArticle(actor)).toEqual({body:'', revision:1});
    await api.savePondArticle(actor,{body:'鱼塘专用',revision:1});
    await expect(api.savePondArticle(actor,{body:'旧草稿',revision:1})).rejects.toThrow('已变更');
    await api.savePondArticle(actor,{body:'鱼塘新版',revision:2});
    await expect(api.savePondArticle(actor,{body:'旧稿',revision:2})).rejects.toThrow('已变更');
    expect(await api.pondArticle(actor)).toEqual({body:'鱼塘新版',revision:3});
    expect((await api.questionArticle(actor,folder.id)).body).toBe('');
    expect(await api.pondArticle({...actor,companyId:0})).toEqual({body:'',revision:1});
    const v = await api.create(actor, folder.id, { name: '初播' }),
      second = await api.create(actor, folder.id, { name: '返场' });
    const image = {
      originalname: 'default.png',
      size: 8,
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    };
    await expect(api.upload(actor, v.id, { category: 'image', name: '  ' }, image)).rejects.toThrow('名称');
    await expect(api.upload(actor, v.id, { category: 'video', name: '假视频' }, image)).rejects.toThrow(
      '格式',
    );
    const a = await api.upload(actor, v.id, { category: 'image', name: ' 籽粒特写 ' }, image);
    const draft = {
      name: '初播',
      notes: '适合新人',
      body: '大家看这粒花生',
      cues: [{ asset: a.id, start: 2, end: 7 }],
      revision: 1,
    };
    await api.save(actor, v.id, draft);
    expect(await api.detail(actor, v.id)).toMatchObject({
      ...draft,
      revision: 2,
      outline: [
        { name: '留人', length: draft.body.length },
        ...['互动', '塑品', '逼单', '追单'].map((name) => ({ name, length: 0 })),
      ],
      assets: [{ id: a.id, name: '籽粒特写' }],
    });
    await expect(api.save(actor, v.id, draft)).rejects.toThrow('版本已变更');
    await expect(api.save(actor, second.id, draft)).rejects.toThrow('本版本');
    await expect(
      api.save(actor, v.id, { ...draft, revision: 2, cues: [{ asset: a.id, start: 0, end: 999 }] }),
    ).rejects.toThrow('范围');
    // Existing question/answer rows remain readable until the product article is edited.
    await ds.query('UPDATE live_script_folders SET faq=? WHERE id=?', [
      JSON.stringify([{ question: '怎么种？', answer: '先整地。' }]),
      folder.id,
    ]);
    const article = await api.questionArticle(actor, folder.id);
    expect(article.body).toBe('怎么种？\n先整地。');
    await api.saveQuestionArticle(actor, folder.id, {
      body: '售前问题\n\n栽培提示',
      revision: article.revision,
    });
    expect((await api.detail(actor, v.id)).revision).toBe(2);
    await expect(
      api.saveQuestionArticle(actor, folder.id, { body: '过期草稿', revision: article.revision }),
    ).rejects.toThrow('问题库已变更');
    await expect(api.questionArticle({ ...actor, companyId: c.id + 1000000 }, folder.id)).rejects.toThrow(
      '不存在',
    );
    await expect(api.url({ ...actor, companyId: c.id + 1000000 }, v.id, a.id)).rejects.toThrow('不存在');
    expect((await api.url(actor, v.id, a.id)).mime).toBe('image/png');
  }, 120000);
});
