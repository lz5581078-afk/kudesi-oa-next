import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedInstaller } from './hosted-installer';
describe('公司版本绑定的EXE安装包', () => {
  let root: string;
  const version = '1.2.1', pkg = 'a'.repeat(64), buf = Buffer.concat([Buffer.from('MZ'),Buffer.alloc(100)]);
  beforeEach(() => { root = mkdtempSync(join(tmpdir(),'hosted-installer-')); });
  afterEach(() => rmSync(root,{recursive:true,force:true}));
  const publish = () => { writeFileSync(join(root,`${version}.json`),JSON.stringify({version,packageSha256:pkg,sha256:createHash('sha256').update(buf).digest('hex')}));writeFileSync(join(root,`KudesiAssistant-Setup-${version}.exe`),buf); };
  it('只发放与本公司已发布升级包摘要一致、完整校验的EXE', () => {
    publish(); const result = hostedInstaller(version,pkg,root)!;
    expect(result.buf).toEqual(buf); expect(result.filename).toBe('KudesiAssistant-Setup-1.2.1.exe');
    expect(hostedInstaller(version,'b'.repeat(64),root)).toBeNull();
    expect(hostedInstaller('1.2.2',pkg,root)).toBeNull();
  });
  it('损坏、符号链接或目录穿越不发放', () => {
    publish(); writeFileSync(join(root,`KudesiAssistant-Setup-${version}.exe`),Buffer.from('bad'));
    expect(()=>hostedInstaller(version,pkg,root)).toThrow('完整性');
    rmSync(join(root,`KudesiAssistant-Setup-${version}.exe`));symlinkSync('1.2.1.json',join(root,`KudesiAssistant-Setup-${version}.exe`));
    expect(()=>hostedInstaller(version,pkg,root)).toThrow('完整性');
    expect(()=>hostedInstaller('../1.2.1',pkg,root)).toThrow('版本');
  });
});
