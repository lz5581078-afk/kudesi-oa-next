import { mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintMigrationLayout } from './software-fingerprint';

describe('迁移程序及适配器指纹',()=>{
  let root:string,layout:Parameters<typeof fingerprintMigrationLayout>[0];
  beforeEach(()=>{
    root=mkdtempSync(join(tmpdir(),'migration-code-pin-'));
    for(const dir of ['api','shared','adapter'])mkdirSync(join(root,dir));
    writeFileSync(join(root,'api/main.js'),'exports.version=1;');writeFileSync(join(root,'shared/pricing.js'),'exports.price=1;');
    writeFileSync(join(root,'adapter/entry.cjs'),'exports.read=()=>{};');writeFileSync(join(root,'adapter/helper.cjs'),'exports.rule=1;');
    writeFileSync(join(root,'adapter/mapping-rules.json'),'{}');writeFileSync(join(root,'package-lock.json'),'{}');
    layout={apiDir:join(root,'api'),sharedDir:join(root,'shared'),adapterPath:join(root,'adapter/entry.cjs'),packages:[{label:'lock',file:join(root,'package-lock.json')}]};
  });
  afterEach(()=>rmSync(root,{recursive:true,force:true}));
  it('API、共享计算、适配器及映射/依赖变动均改变指纹；重复读取稳定',()=>{
    const initial=fingerprintMigrationLayout(layout);expect(fingerprintMigrationLayout(layout)).toBe(initial);
    for(const file of ['api/main.js','shared/pricing.js','adapter/helper.cjs','adapter/mapping-rules.json','package-lock.json']){
      writeFileSync(join(root,file),'changed-'+file);expect(fingerprintMigrationLayout(layout)).not.toBe(initial);
      // Restore this fixture so each dependency is checked independently.
      writeFileSync(join(root,file),file==='api/main.js'?'exports.version=1;':file==='shared/pricing.js'?'exports.price=1;':file==='adapter/helper.cjs'?'exports.rule=1;':'{}');
      expect(fingerprintMigrationLayout(layout)).toBe(initial);
    }
  });
  it('入口身份参与指纹；环境及业务报告不作为程序代码读取',()=>{
    writeFileSync(join(root,'adapter/other.cjs'),'exports.read=()=>{};');
    const initial=fingerprintMigrationLayout(layout);
    expect(fingerprintMigrationLayout({...layout,adapterPath:join(root,'adapter/other.cjs')})).not.toBe(initial);
    writeFileSync(join(root,'api/.env'),'fixture-environment-only');writeFileSync(join(root,'adapter/report.json'),'fixture-private-business-report');
    expect(fingerprintMigrationLayout(layout)).toBe(initial);
  });
  it('代码目录的符号链接不被悄悄跳过或用于读取目录外数据',()=>{
    writeFileSync(join(root,'outside.js'),'outside');symlinkSync(join(root,'outside.js'),join(root,'adapter/link.cjs'));
    expect(()=>fingerprintMigrationLayout(layout)).toThrow('符号链接');
  });
});
