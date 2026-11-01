import 'reflect-metadata';
import { createRequire } from 'node:module';
import { basename,dirname,isAbsolute,resolve } from 'node:path';
import { lstatSync,openSync,closeSync,writeFileSync } from 'node:fs';
import { RESOURCE_DEFS } from '@kudesi/shared';
import { loadEnv } from '../config/env';
import { CryptoService } from '../common/crypto.service';
import { parseWeightScope } from '../integrations/express-recognition';
import { migrationSoftwareFingerprint } from '../migration/software-fingerprint';
import { writeSealedArchive,readSealedArchive,sealedSourceHash } from '../migration/sealed-source';
import type { LegacyArchive } from '../migration/protocol';
import { MigrationError,safeFailure } from '../migration/runner';

/** Creates a private source artifact only. Does not connect to the target DB,
 * start an API/worker, import records or authorize an eventual cutover. */
async function main(){
  const args=process.argv.slice(2),arg=(key:string)=>{const i=args.indexOf(key);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw new MigrationError('封存参数不完整');return args[i+1];};
  if(args.includes('--apply'))throw new MigrationError('封存来源不接受写入参数');
  const sourceCompanyId=Number(arg('--source-company')),adapterArg=arg('--adapter'),directoryArg=arg('--directory');
  if(!Number.isSafeInteger(sourceCompanyId)||sourceCompanyId<1||!isAbsolute(adapterArg)||!isAbsolute(directoryArg))throw new MigrationError('来源公司与封存绝对路径不正确');
  const adapterPath=resolve(adapterArg),directory=resolve(directoryArg),parent=dirname(directory);
  if(basename(directory)!==`company-${sourceCompanyId}`||!/^[A-Za-z0-9_-]+\.cjs$/.test(basename(adapterPath))||basename(adapterPath)==='sealed-adapter.cjs'||(lstatSync(parent).mode&0o077)!==0)throw new MigrationError('封存必须位于私有批次目录，使用原始CJS适配器与company-来源编号子目录');
  const receiptPath=resolve(parent,`company-${sourceCompanyId}.receipt.json`),receiptHandle=openSync(receiptPath,'wx',0o600);
  closeSync(receiptHandle);writeFileSync(receiptPath,JSON.stringify({phase:'sealing; not approved',sourceCompanyId}));
  const env=loadEnv(),crypto=new CryptoService(env.encryptionKeys,env.encryptionActiveKeyId),softwareFingerprint=migrationSoftwareFingerprint(adapterPath);
  const adapter=createRequire(adapterPath)(adapterPath) as {read(opts:Record<string,unknown>):Promise<LegacyArchive>};
  let source:LegacyArchive|null=await adapter.read({sourceCompanyId,definitions:RESOURCE_DEFS,parseWeightScope,preserveCostHistory:true,preserveLegacyStates:true,includeWorkflowContinuations:true});
  const inventory=source.sourceRows?.filter(r=>r.table==='legacy_schema_inventory'&&r.key==='current')??[];
  if(source.company.id!==sourceCompanyId||inventory.length!==1||inventory[0].row.version!==1||migrationSoftwareFingerprint(adapterPath)!==softwareFingerprint)throw new MigrationError('来源身份/全表清单或程序发生变化，未完成封存');
  const pin={sourceCompanyId,softwareFingerprint},receipt=await writeSealedArchive(directory,source,crypto,pin);
  // The real source includes large inline attachments. Do not retain a second
  // complete archive while independently reading back the encrypted artifact.
  source=null;
  const reread=await readSealedArchive(directory,crypto,receipt.sha256,pin);
  if(sealedSourceHash(reread)!==receipt.sourceHash||migrationSoftwareFingerprint(adapterPath)!==softwareFingerprint)throw new MigrationError('封存后回读或程序核对未通过，禁止使用该包');
  const report={phase:'sealed and reread; not a cutover approval',format:1,sourceCompanyId,sourceAdapter:basename(adapterPath),softwareFingerprint,...receipt};
  writeFileSync(receiptPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error('来源封存已停止：',safeFailure(e));process.exitCode=1;});
