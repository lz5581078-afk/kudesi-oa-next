import * as crypto from 'crypto';
import { QiniuClient, QiniuConfig } from './qiniu.client';
import { extractJson } from './vision.client';
import { normalizeDate, normalizeLicenseFields } from './ocr.service';
import { cleanFileName, sniffFile } from './files.service';

const cfg: QiniuConfig = { accessKey: 'AK', secretKey: 'SK', bucket: 'oa-bucket', zone: 'z2', domain: 'https://cdn.example.com/', isPrivate: true };
const hmac = (data: string) => crypto.createHmac('sha1', 'SK').update(data).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');

describe('七牛客户端', () => {
  const now = () => 1_700_000_000_000;

  it('上传凭证：只允许传到指定 key，带过期时间和大小限制，签名正确', () => {
    const token = new QiniuClient(cfg, fetch, now).uploadToken('oa/1/licenses/a.png', 600, 2048);
    const [ak, sign, encoded] = token.split(':');
    expect(ak).toBe('AK');
    expect(sign).toBe(hmac(encoded));
    const policy = JSON.parse(Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    expect(policy).toEqual({ scope: 'oa-bucket:oa/1/licenses/a.png', deadline: 1_700_000_600, fsizeLimit: 2048 });
  });

  it('私有空间的下载链接带过期时间和签名；公开空间是普通链接；文件名里的中文会被编码', () => {
    const url = new QiniuClient(cfg, fetch, now).downloadUrl('oa/1/x y/营业执照.png', 300);
    const withExpiry = 'https://cdn.example.com/oa/1/x%20y/%E8%90%A5%E4%B8%9A%E6%89%A7%E7%85%A7.png?e=1700000300';
    expect(url).toBe(`${withExpiry}&token=AK:${hmac(withExpiry)}`);
    expect(new QiniuClient({ ...cfg, isPrivate: false }, fetch, now).downloadUrl('a/b.png')).toBe('https://cdn.example.com/a/b.png');
  });

  it('上传走所选区域的上传域名，失败时带出七牛的错误信息', async () => {
    const calls: Array<{ url: string; body: FormData }> = [];
    const ok = (async (url: string, init: { body: FormData }) => {
      calls.push({ url, body: init.body });
      return new Response('{"key":"k"}', { status: 200 });
    }) as unknown as typeof fetch;
    await new QiniuClient(cfg, ok, now).upload('k', Buffer.from('x'), 'image/png', 'a.png');
    expect(calls[0].url).toBe('https://upload-z2.qiniup.com');
    expect(calls[0].body.get('key')).toBe('k');
    expect(String(calls[0].body.get('token'))).toContain('AK:');
    const bad = (async () => new Response('{"error":"bad token"}', { status: 401 })) as unknown as typeof fetch;
    await expect(new QiniuClient(cfg, bad, now).upload('k', Buffer.from('x'), 'image/png', 'a.png')).rejects.toThrow(/401.*bad token/);
  });

  it('删除：签名在 /delete/... 路径上；文件已不存在(612)算成功', async () => {
    let seen: { url: string; auth: string } | null = null;
    const f = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, auth: init.headers.Authorization };
      return { ok: false, status: 612 } as unknown as Response;
    }) as unknown as typeof fetch;
    await new QiniuClient(cfg, f, now).remove('a/b.png');
    const path = new URL(seen!.url).pathname;
    expect(seen!.auth).toBe(`QBox AK:${hmac(`${path}\n`)}`);
    const entry = path.replace('/delete/', '').replace(/-/g, '+').replace(/_/g, '/');
    expect(Buffer.from(entry, 'base64').toString()).toBe('oa-bucket:a/b.png');
  });
});

describe('文件类型识别（按文件头，不信扩展名）', () => {
  it('认得 png/jpg/gif/webp/pdf，认不出的返回 null', () => {
    expect(sniffFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext).toBe('png');
    expect(sniffFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg');
    expect(sniffFile(Buffer.from('GIF89a....'))?.ext).toBe('gif');
    expect(sniffFile(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.ext).toBe('webp');
    expect(sniffFile(Buffer.from('%PDF-1.7'))).toMatchObject({ mime: 'application/pdf', image: false });
    expect(sniffFile(Buffer.from('MZ\x90\x00 an exe'))).toBeNull();
    expect(sniffFile(Buffer.from('<script>alert(1)</script>'))).toBeNull();
  });

  it('文件名：还原中文、去掉路径和控制字符', () => {
    const latin1 = Buffer.from('营业执照.png', 'utf8').toString('latin1');
    expect(cleanFileName(latin1)).toBe('营业执照.png');
    expect(cleanFileName('营业执照.png')).toBe('营业执照.png'); // 已经是正常中文，不能再转一次
    expect(cleanFileName('café.png')).toBe('café.png');
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('a\u0000b.png')).toBe('ab.png');
  });
});

describe('识别结果处理', () => {
  it('从代码块或夹杂文字的回复里取出 JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('结果如下：{"a":"b"} 以上')).toEqual({ a: 'b' });
    expect(extractJson('没有 JSON')).toBeNull();
    expect(extractJson('[1,2]')).toBeNull();
  });

  it('日期统一成 YYYY-MM-DD，认不出的留空', () => {
    expect(normalizeDate('2015年3月2日')).toBe('2015-03-02');
    expect(normalizeDate('2015.03.12')).toBe('2015-03-12');
    expect(normalizeDate('长期')).toBe('');
    expect(normalizeDate('2015年13月1日')).toBe('');
  });

  it('信用代码转大写去空格，不是 18 位给出提醒；空值不返回', () => {
    const ok = normalizeLicenseFields({ companyName: ' 甲公司 ', creditCode: '91310000 ma1abc1234', legalPerson: '', foundedAt: '2015年3月2日' });
    expect(ok.fields).toEqual({ companyName: '甲公司', creditCode: '91310000MA1ABC1234', foundedAt: '2015-03-02' });
    expect(ok.warnings.length).toBe(0);
    const bad = normalizeLicenseFields({ creditCode: '123', approvedAt: '不详' });
    expect(bad.warnings.join('|')).toContain('不是 18 位');
    expect(bad.warnings.join('|')).toContain('日期没认出来');
    expect(bad.fields.approvedAt).toBeUndefined();
  });
});
