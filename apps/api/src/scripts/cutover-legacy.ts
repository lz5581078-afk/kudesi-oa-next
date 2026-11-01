import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync,lstatSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { DataSource } from 'typeorm';
import { RESOURCE_DEFS } from '@kudesi/shared';
import { loadEnv } from '../config/env';
import { CryptoService } from '../common/crypto.service';
import { buildDataSourceOptions,alignSessionTimeZone } from '../database/data-source';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import { FilesService,defaultStorageFactory } from '../integrations/files.service';
import { ResourcesService } from '../resources/resources.service';
import { IntegrationSetting,ResourceChangeLog,ResourceFile } from '../entities';
import { migrationSoftwareFingerprint } from '../migration/software-fingerprint';
import { MigrationError,safeFailure,type ImportResult } from '../migration/runner';
import { prepareCutoverSequences,runCutover,type CutoverResult,type CompanyPlan } from '../migration/cutover';
import type { LegacyArchive } from '../migration/protocol';
import { parseWeightScope } from '../integrations/express-recognition';

const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
function privateJson(path:string){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw new MigrationError('切换凭据必须为私有普通文件');return JSON.parse(readFileSync(path,'utf8'));}
async function main(){
  const args=process.argv.slice(2),arg=(k:string)=>{const i=args.indexOf(k);if(i<0||!args[i+1]||!args[i+1].startsWith('/'))throw new MigrationError('切换路径参数必须为绝对路径');return resolve(args[i+1]);};
  const planFile=arg('--plan'),plan=privateJson(planFile) as {version:number;decision:string;companies:CompanyPlan[];backupDigest:string;identityFloor:number;freezeProof:string},reportFile=arg('--report'),adapterPath=arg('--adapter'),proofPath=arg('--backup-proof'),baselineDir=arg('--baseline-dir');
  const proof=privateJson(proofPath),backupDigest=sha(readFileSync(proofPath)),apply=args.includes('--apply');
  if(plan.version!==1||plan.decision!=='verified-scope-first-retain-rest'||!Array.isArray(plan.companies)||!plan.companies.length||proof.phase!=='databases and files restored and verified'||proof.productionDataChanged!==false)throw new MigrationError('切换范围或备份恢复凭据未就绪');
  if(plan.backupDigest!==backupDigest)throw new MigrationError('切换计划未绑定当前恢复凭据');
  for(const c of plan.companies)if(![c.sourceCompanyId,c.companyId,c.actorId].every(n=>Number.isSafeInteger(n)&&n>0)||typeof c.name!=='string'||!c.name)throw new MigrationError('公司身份计划无效');
  const env=loadEnv();if(apply){const i=args.indexOf('--confirm');if(args[i+1]!==env.db.name+':all-companies:verified-scope-first-retain-rest')throw new MigrationError('统一切换确认不匹配目标库');}
  if(apply){const freeze=privateJson(plan.freezeProof);if(freeze.phase!=='source and target writers stopped'||freeze.backupDigest!==backupDigest)throw new MigrationError('停写凭据未绑定本次已恢复备份');}
  const expected:CutoverResult|undefined=apply?privateJson(arg('--expected-report')):undefined;
  if(expected?.phase!=='dry-run-rollback'&&apply)throw new MigrationError('正式切换必须使用统一回滚报告');
  writeFileSync(reportFile,JSON.stringify({phase:'started; not committed'}),{flag:'wx',mode:0o600});
  const softwareFingerprint=migrationSoftwareFingerprint(adapterPath),adapter=createRequire(adapterPath)(adapterPath);
  const sources:LegacyArchive[]=[];
  for(const c of plan.companies){const source:LegacyArchive=await adapter.read({sourceCompanyId:c.sourceCompanyId,definitions:RESOURCE_DEFS,parseWeightScope,preserveCostHistory:true,preserveLegacyStates:true,includeWorkflowContinuations:true});
    if(source.company.id!==c.sourceCompanyId||source.company.name!==c.name||source.sourceRows?.filter(r=>r.table==='legacy_schema_inventory'&&r.key==='current').length!==1)throw new MigrationError('封存来源或全表清单不完整');sources.push(source);}
  if(migrationSoftwareFingerprint(adapterPath)!==softwareFingerprint)throw new MigrationError('封存读取期间程序变化');
  const ds=await alignSessionTimeZone(await new DataSource(buildDataSourceOptions()).initialize());
  try{
    if(await ds.showMigrations())throw new MigrationError('结构迁移必须预先核对执行，切换不隐式改表');
    const crypto=new CryptoService(env.encryptionKeys,env.encryptionActiveKeyId),settings=new IntegrationSettingsService(ds.getRepository(IntegrationSetting),ds.getRepository(ResourceChangeLog),crypto);
    if(!process.env.FILES_LOCAL_ROOT)throw new MigrationError('统一切换附件必须使用服务器本地私有存储');
    // Import files locally, retaining current encrypted cloud settings untouched.
    settings.getQiniu=async()=>null;
    const files=new FilesService(ds,settings,defaultStorageFactory),resources=new ResourcesService(ds,crypto,files);
    const baselines=new Map<number,ImportResult>();for(const c of plan.companies)baselines.set(c.companyId,privateJson(join(baselineDir,'company-'+c.sourceCompanyId+'-dry-48.json')));
    await prepareCutoverSequences(ds,plan.identityFloor);
    const result=await runCutover(ds,resources,files,crypto,sources,{apply,plans:plan.companies as CompanyPlan[],softwareFingerprint,backupDigest,expected,
      writeReport:r=>writeFileSync(reportFile,JSON.stringify(r,null,2),{mode:0o600}),
      verify:async(em,r)=>{
        for(const part of r.reports){const baseline=baselines.get(part.companyId);if(!baseline||baseline.failures.length)throw new MigrationError('演练范围基线不可用');
          const pairs=(x:ImportResult)=>JSON.stringify([...new Set(x.excluded.map(e=>JSON.stringify([e.type,e.id])))].sort());
          if(pairs(part)!==pairs(baseline))throw new MigrationError('最新来源出现演练范围以外的待迁项目，整批回滚');
        }
        const allFiles=await em.find(ResourceFile),seen=new Set<number>();
        for(const part of r.reports){const source=sources.find(s=>s.company.id===plan.companies.find(c=>c.companyId===part.companyId)!.sourceCompanyId)!;
          for(const record of source.records)for(const f of record.files??[]){
            const key=`${record.type}:${record.id}:${f.field}:${f.id}`,mapping=part.mappings.find(m=>m.type==='file'&&m.sourceId===key);
            const native=mapping&&allFiles.find(n=>n.id===mapping.targetId&&n.companyId===part.companyId);
            if(!native||!f.contentHash||!/^local:oa\/\d+\/[a-z0-9-]+\/\d{6}\/[0-9a-f-]+\.(png|jpg|gif|webp|pdf)$/.test(native.storageKey))throw new MigrationError('切换附件原生引用不完整');
            const bytes=readFileSync(join(process.env.FILES_LOCAL_ROOT!,native.storageKey.slice(6)));if(sha(bytes)!==f.contentHash||bytes.length!==Number(native.size))throw new MigrationError('切换附件逐个摘要或大小不一致');seen.add(native.id);
          }
        }
        if(allFiles.length!==seen.size)throw new MigrationError('附件数量与来源引用不一致');
        if(apply&&!existsSync(plan.freezeProof))throw new MigrationError('正式切换缺少停写凭据');
      }});
    console.log(JSON.stringify({phase:result.phase,companies:result.reports.length,users:result.counts.users,files:result.counts.resource_files,deferred:true}));
  }finally{await ds.destroy();}
}
main().catch(e=>{console.error('统一切换已停止：',safeFailure(e));process.exitCode=1;});
