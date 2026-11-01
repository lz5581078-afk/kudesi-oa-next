import { createHash,randomBytes } from 'node:crypto';
import { mkdtemp,mkdir,readFile,writeFile,rm,chmod,symlink,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoService } from '../common/crypto.service';
import { writeSealedArchive,readSealedArchive,sealedSourceHash } from './sealed-source';
import type { LegacyArchive } from './protocol';
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
describe('固定来源的加密迁移包',()=>{
  let parent:string,dir:string,crypto:CryptoService,source:LegacyArchive;
  const pin={sourceCompanyId:3,softwareFingerprint:'a'.repeat(64)},bytes=Buffer.from('fixture-private-photo-bytes');
  beforeEach(async()=>{
    parent=await mkdtemp(join(tmpdir(),'sealed-legacy-'));dir=join(parent,'batch');crypto=new CryptoService({one:randomBytes(32)},'one');
    source={company:{id:3,name:'封存测试'},departments:[],positions:[],employees:[{id:1,password_hash:'fixture-private-value'}],employeePositions:[],positionPermissions:[],exclusions:[],
      sourceRows:[{table:'test_rows',key:'1',row:{id:'1',company_id:3,value:'0.000001',empty:null,remark:' 原文\n',nested:JSON.parse('{"__proto__":{"polluted":"fixture"},"constructor":"original"}')}}],
      records:[1,2].map(i=>({id:String(i),type:'qualifications',data:{name:'原资料'+i,optional:undefined,zero:0},files:[{field:'attachments',id:String(i),name:'原/附件'+i+'.png',locator:'old:'+i,contentHash:hash(bytes)}]})),
      loadFile:async()=>Buffer.from(bytes),workflow:{companyId:3,tables:{workflow_instances:[{id:'123',status:'processing'}]},access:{policyHash:'source-proof',employees:[]}},
    };
  });
  afterEach(async()=>{await rm(parent,{recursive:true,force:true});});
  it('逐行加密往返保留精度/空值/空白、原文件名和流程进度；同内容附件去重且原对象不被改写',async()=>{
    const original=JSON.stringify(source),receipt=await writeSealedArchive(dir,source,crypto,pin);
    expect(receipt).toMatchObject({files:1,fileReferences:2,fileBytes:bytes.length,sourceHash:sealedSourceHash(source)});
    const ciphertext=await readFile(join(dir,'archive.enc'));expect(hash(ciphertext)).toBe(receipt.sha256);expect(ciphertext.includes('fixture-private-value')).toBe(false);expect(ciphertext.includes('封存测试')).toBe(false);
    const loaded=await readSealedArchive(dir,crypto,receipt.sha256,pin);
    const restored={...loaded,records:loaded.records.map((r,i)=>({
      ...r,files:r.files?.map((f,j)=>({...f,locator:source.records[i].files![j].locator})),
    }))};
    expect(JSON.parse(JSON.stringify(restored))).toEqual(JSON.parse(original));
    expect(await loaded.loadFile(loaded.records[1].files![0].locator)).toEqual(bytes);expect(JSON.stringify(source)).toBe(original);expect(({} as Record<string,unknown>).polluted).toBeUndefined();
  });
  it('截断、重排、替换密文及删掉最后换行均拒绝，即使篡改者重算了文件摘要',async()=>{
    const receipt=await writeSealedArchive(dir,source,crypto,pin),file=join(dir,'archive.enc'),original=await readFile(file,'utf8'),lines=original.trimEnd().split('\n');
    const mutations=[lines.slice(0,-1).join('\n')+'\n',[lines[0],lines[2],lines[1],...lines.slice(3)].join('\n')+'\n',original.slice(0,20)+(original[20]==='A'?'B':'A')+original.slice(21)];
    for(const changed of mutations){await writeFile(file,changed);await expect(readSealedArchive(dir,crypto,hash(changed),pin)).rejects.toThrow('校验失败');}
    await writeFile(file,original.slice(0,-1));await expect(readSealedArchive(dir,crypto,receipt.sha256,pin)).rejects.toThrow('校验失败');
  });
  it('公司、程序、密钥或已核对包摘要不同就拒绝',async()=>{
    const r=await writeSealedArchive(dir,source,crypto,pin);
    for(const p of [{...pin,sourceCompanyId:4},{...pin,softwareFingerprint:'b'.repeat(64)}])await expect(readSealedArchive(dir,crypto,r.sha256,p)).rejects.toThrow('校验失败');
    await expect(readSealedArchive(dir,new CryptoService({one:randomBytes(32)},'one'),r.sha256,pin)).rejects.toThrow('校验失败');
    await expect(readSealedArchive(dir,crypto,'0'.repeat(64),pin)).rejects.toThrow('校验失败');
  });
  it('空跑读取前也逐个检查附件；损坏、外链定位和文件/目录符号链接均拒绝',async()=>{
    const r=await writeSealedArchive(dir,source,crypto,pin),photo=join(dir,'files',hash(bytes));
    await writeFile(photo,'corrupted');await expect(readSealedArchive(dir,crypto,r.sha256,pin)).rejects.toThrow('校验失败');
    await rm(photo);const outside=join(parent,'outside');await writeFile(outside,bytes,{mode:0o600});await symlink(outside,photo);await expect(readSealedArchive(dir,crypto,r.sha256,pin)).rejects.toThrow('校验失败');
    await rm(photo);await writeFile(photo,bytes,{mode:0o600});const loaded=await readSealedArchive(dir,crypto,r.sha256,pin);await expect(loaded.loadFile('../../outside')).rejects.toThrow('校验失败');
    await rm(join(dir,'files'),{recursive:true});await mkdir(join(parent,'outside-files'),{mode:0o700});await symlink(join(parent,'outside-files'),join(dir,'files'));await expect(readSealedArchive(dir,crypto,r.sha256,pin)).rejects.toThrow('校验失败');
  });
  it('不覆盖现有目录，失败清理新建残包；不默默丢弃不安全数字、Date、二进制或数组空洞',async()=>{
    await mkdir(dir,{mode:0o700});await writeFile(join(dir,'keep'),'original');await expect(writeSealedArchive(dir,source,crypto,pin)).rejects.toThrow();expect(await readFile(join(dir,'keep'),'utf8')).toBe('original');await rm(dir,{recursive:true});
    for(const value of [Number.MAX_SAFE_INTEGER+1,new Date(),Buffer.from('binary'),Array(2)]){
      source.records[0].data.bad=value;await expect(writeSealedArchive(dir,source,crypto,pin)).rejects.toThrow('校验失败');await expect(access(dir)).rejects.toThrow();
    }
  });
  it('包、目录必须保持私有权限，坏附件摘要不能写成可使用包',async()=>{
    const r=await writeSealedArchive(dir,source,crypto,pin);await chmod(join(dir,'archive.enc'),0o644);await expect(readSealedArchive(dir,crypto,r.sha256,pin)).rejects.toThrow('校验失败');await chmod(join(dir,'archive.enc'),0o600);await chmod(dir,0o755);await expect(readSealedArchive(dir,crypto,r.sha256,pin)).rejects.toThrow('校验失败');await chmod(dir,0o700);await rm(dir,{recursive:true});
    source.records[0].files![0].contentHash='0'.repeat(64);await expect(writeSealedArchive(dir,source,crypto,pin)).rejects.toThrow('校验失败');await expect(access(dir)).rejects.toThrow();
  });
});
