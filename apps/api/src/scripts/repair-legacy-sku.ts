import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DataSource } from 'typeorm';
import { RESOURCE_DEFS } from '@kudesi/shared';
import { buildDataSourceOptions, alignSessionTimeZone } from '../database/data-source';
import { loadEnv } from '../config/env';
import { CryptoService } from '../common/crypto.service';
import { FilesService, defaultStorageFactory } from '../integrations/files.service';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import { IntegrationSetting, ResourceChangeLog } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { MigrationError, runLegacyImport, safeFailure } from '../migration/runner';
import { runSkuRepair, planSkuRepair, runSkuVerification, SKU_SOURCE_TYPES } from '../migration/sku-repair';
import { LegacyArchive } from '../migration/protocol';
import { parseWeightScope } from '../integrations/express-recognition';
import { configureSkuWorkflow } from '../migration/sku-workflow';

async function main(){
  const args=process.argv.slice(2),arg=(k:string)=>{const i=args.indexOf(k);if(i<0||!args[i+1])throw new MigrationError(`缺少参数 ${k}`);return args[i+1];};
  const sourceCompanyId=Number(arg('--source-company')),companyId=Number(arg('--company')),actorId=Number(arg('--actor')),expectedName=arg('--expected-name'),mode=arg('--mode'),apply=args.includes('--apply');
  if(![sourceCompanyId,companyId,actorId].every(n=>Number.isInteger(n)&&n>0)||!['fields','missing','verify','workflow'].includes(mode))throw new MigrationError('公司、操作人或修复模式无效');
  const report=resolve(arg('--report')),expected=args.includes('--expected-report')?JSON.parse(readFileSync(resolve(arg('--expected-report')),'utf8')):undefined;
  const env=loadEnv();if(apply&&(!expected||arg('--confirm')!==`${env.db.name}:${companyId}:${sourceCompanyId}`))throw new MigrationError('正式修复需要已核对报告及库/公司确认');
  writeFileSync(report,JSON.stringify({phase:'started; not committed',mode}),{mode:0o600,flag:'wx'});
  const adapterPath=resolve(arg('--adapter')),adapter=createRequire(adapterPath)(adapterPath) as {read:(o:unknown)=>Promise<LegacyArchive>};
  const source=await adapter.read({sourceCompanyId,definitions:RESOURCE_DEFS.filter(d=>SKU_SOURCE_TYPES.includes(d.key)),parseWeightScope});
  if(source.company.id!==sourceCompanyId)throw new MigrationError('来源公司不一致');
  const ds=await alignSessionTimeZone(await new DataSource(buildDataSourceOptions()).initialize());
  try{
    if(await ds.showMigrations())throw new MigrationError('目标结构迁移未完成');
    const crypto=new CryptoService(env.encryptionKeys,env.encryptionActiveKeyId),settings=new IntegrationSettingsService(ds.getRepository(IntegrationSetting),ds.getRepository(ResourceChangeLog),crypto),files=new FilesService(ds,settings,defaultStorageFactory),resources=new ResourcesService(ds,crypto,files);
    if(mode==='fields'){
      const plan=await runSkuRepair(ds,resources,source,{companyId,actorId,expectedName,apply,expectedPlan:expected?.plan,preparePlan:plan=>writeFileSync(report,JSON.stringify({phase:'prepared; not committed',mode,plan},null,2),{mode:0o600})});
      writeFileSync(report,JSON.stringify({phase:apply?'committed':'dry-run-rollback',mode,plan},null,2),{mode:0o600});
      console.log(JSON.stringify({phase:apply?'committed':'dry-run-rollback',patches:plan.patches.length,conflicts:plan.conflicts.length,missing:plan.additions.length}));
    }else if(mode==='workflow'){
      const plan=await configureSkuWorkflow(ds,resources,{companyId,actorId,expectedName,warehouseDepartmentId:Number(arg('--warehouse-department')),financePositionId:Number(arg('--finance-position')),grantRequiredFinancePermissions:args.includes('--grant-required-finance-permissions'),apply,expected:expected?.workflow,prepare:workflow=>writeFileSync(report,JSON.stringify({phase:'prepared; not committed',mode,workflow},null,2),{mode:0o600})});
      writeFileSync(report,JSON.stringify({phase:apply?'committed':'dry-run-rollback',mode,workflow:plan},null,2),{mode:0o600});console.log(JSON.stringify({phase:apply?'committed':'dry-run-rollback',warehouseCount:plan.warehouseIds.length,financeCount:plan.financeIds.length}));
    }else if(mode==='verify'){
      const result=await runSkuVerification(ds,resources,source,{companyId,actorId,expectedName,apply,expected:expected?.verification,prepare:verification=>writeFileSync(report,JSON.stringify({phase:'prepared; not committed',mode,verification},null,2),{mode:0o600})});
      writeFileSync(report,JSON.stringify({phase:apply?'committed':'dry-run-rollback',mode,verification:result},null,2),{mode:0o600});console.log(JSON.stringify({checked:result.checked.length,issues:result.issues.length}));
    }else{
      if(apply&&expected?.result?.failures?.length)throw new MigrationError('增量空跑仍有失败，禁止正式补入');
      const plan=await planSkuRepair(ds.manager,companyId,source),keys=new Set(plan.additions.map(r=>`${r.type}:${r.id}`));
      const incremental:LegacyArchive={...source,departments:[],positions:[],employees:[],employeePositions:[],positionPermissions:[],employeeOverrides:[],positionDuties:[],compensationRecords:[],links:[],records:source.records.filter(r=>keys.has(`${r.type}:${r.id}`))};
      const result=await runLegacyImport(ds,resources,files,incremental,{companyId,actorId,expectedName,apply,expectedReport:expected?.result,prepareReport:result=>writeFileSync(report,JSON.stringify({phase:'prepared; not committed',mode,result},null,2),{mode:0o600})});
      writeFileSync(report,JSON.stringify({phase:result.phase,mode,result},null,2),{mode:0o600});console.log(JSON.stringify({phase:result.phase,created:result.created,failed:result.failures.length}));
    }
  }finally{await ds.destroy();}
}
main().catch(e=>{console.error('SKU修复停止：',safeFailure(e));process.exitCode=1;});
