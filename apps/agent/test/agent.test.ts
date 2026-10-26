import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findBrowserExecutable } from '../src/browser';
import { normalizeServer } from '../src/cli';
import { clearAuthorization, loadConfig, profileDirFor, saveConfig } from '../src/config';
import { scrub } from '../src/jobs';
import { getPlatform, isLoginUrl, ownsUrl } from '../src/platforms';

describe('平台识别与域名白名单', () => {
  it('中文名和别名都能识别；不认识的平台明确报错', () => {
    expect(getPlatform('pdd').code).toBe('pdd');
    expect(getPlatform('拼多多').code).toBe('pdd');
    expect(getPlatform('tmall').code).toBe('taobao');
    expect(getPlatform('jd').homeUrl).toContain('shop.jd.com');
    expect(() => getPlatform('xhs')).toThrow(/暂不支持/);
    expect(() => getPlatform('')).toThrow(/暂不支持/);
    expect(() => getPlatform('test')).toThrow(/暂不支持/); // 没设置测试环境变量时没有“test”平台
  });
  it('只认平台自己的 https 域名，仿冒域名、http、别的平台都不认', () => {
    const pdd = getPlatform('pdd');
    expect(ownsUrl(pdd, 'https://mms.pinduoduo.com/home')).toBe(true);
    expect(ownsUrl(pdd, 'https://pinduoduo.com/')).toBe(true);
    expect(ownsUrl(pdd, 'http://mms.pinduoduo.com/')).toBe(false);
    expect(ownsUrl(pdd, 'https://pinduoduo.com.evil.cn/')).toBe(false);
    expect(ownsUrl(pdd, 'https://evilpinduoduo.com/')).toBe(false);
    expect(ownsUrl(pdd, 'https://shop.jd.com/')).toBe(false);
    expect(ownsUrl(pdd, 'not a url')).toBe(false);
  });
  it('登录页判断', () => {
    const tb = getPlatform('taobao');
    expect(isLoginUrl(tb, 'https://login.taobao.com/member/login.jhtml')).toBe(true);
    expect(isLoginUrl(tb, 'https://myseller.taobao.com/home.htm')).toBe(false);
    expect(isLoginUrl(getPlatform('pdd'), 'https://mms.pinduoduo.com/login/?redirect=1')).toBe(true);
  });
  it('测试平台只有设置了环境变量才存在', () => {
    process.env.KUDESI_AGENT_TEST_URL = 'http://127.0.0.1:5999/';
    try {
      const t = getPlatform('pdd');
      expect(ownsUrl(t, 'http://127.0.0.1:5999/orders')).toBe(true);
      expect(ownsUrl(t, 'http://127.0.0.1:6000/')).toBe(true); // 同主机不同端口：测试用，主机匹配即可
      expect(ownsUrl(t, 'http://evil.example.com/')).toBe(false);
    } finally { delete process.env.KUDESI_AGENT_TEST_URL; }
  });
});

describe('密码不外泄、地址校验、浏览器查找', () => {
  it('回报给服务器的错误文字里抹掉密码', () => {
    expect(scrub('登录失败 密码 Abc12345 不对', 'Abc12345')).toBe('登录失败 密码 ****** 不对');
    expect(scrub('x'.repeat(500)).length).toBe(280);
    expect(scrub('ab', 'ab')).toBe('ab'); // 太短的不替换，避免把正常文字打碎
  });
  it('OA 地址必须是 https（本机除外）', () => {
    expect(normalizeServer('https://oa.example.com/')).toBe('https://oa.example.com');
    expect(normalizeServer('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
    expect(() => normalizeServer('http://oa.example.com')).toThrow(/https/);
    expect(() => normalizeServer('')).toThrow(/https/);
  });
  it('浏览器：环境变量优先；找不到给出明确提示', () => {
    expect(findBrowserExecutable({ KUDESI_CHROME: '/x/chrome' } as never, () => true)).toBe('/x/chrome');
    expect(() => findBrowserExecutable({ KUDESI_CHROME: '/x/none' } as never, () => false)).toThrow(/不存在/);
    expect(() => findBrowserExecutable({} as never, () => false)).toThrow(/Chrome/);
  });
});

describe('本机配置', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kagent-')); process.env.KUDESI_AGENT_DATA_DIR = dir; });
  afterEach(async () => { delete process.env.KUDESI_AGENT_DATA_DIR; await fs.rm(dir, { recursive: true, force: true }); });

  it('保存/读取；每家店铺一个独立随机 Profile 目录；撤销后令牌被清掉但 Profile 保留', async () => {
    expect(await loadConfig()).toBeNull();
    const cfg = { serverUrl: 'http://127.0.0.1:4000', deviceId: 1, deviceNo: 'N1', deviceToken: 'a'.repeat(64), name: '电脑', profiles: {} };
    await saveConfig(cfg);
    const a = await profileDirFor(cfg, 11);
    const b = await profileDirFor(cfg, 12);
    expect(a).not.toBe(b);
    expect(await profileDirFor(cfg, 11)).toBe(a); // 同一家店铺目录稳定
    expect(a.startsWith(dir)).toBe(true);
    expect(path.basename(a)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // 目录名为随机 UUID；随机字符偶尔包含店铺编号并不代表泄露
    const loaded = (await loadConfig())!;
    expect(loaded.profiles['11']).toBe(path.basename(a));
    await clearAuthorization(loaded);
    const after = (await loadConfig())!;
    expect(after.deviceToken).toBe('');
    expect(after.revokedAt).toBeTruthy();
    expect(after.profiles['11']).toBe(path.basename(a));
    if (process.platform !== 'win32') expect((await fs.stat(path.join(dir, 'agent.json'))).mode & 0o077).toBe(0); // 只有自己能读
  });
});
