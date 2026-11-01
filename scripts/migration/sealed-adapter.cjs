'use strict';
const fs=require('node:fs'),path=require('node:path');
/** Reads only a fully verified private sealed package. Never reconnects to the
 * old database and never loads an arbitrary adapter named by request input. */
exports.read=async opts=>{
  const root=process.env.LEGACY_SEALED_ROOT;
  if(!root||!path.isAbsolute(root)||!Number.isSafeInteger(opts.sourceCompanyId)||opts.sourceCompanyId<1||!opts.preserveCostHistory||!opts.preserveLegacyStates||!opts.includeWorkflowContinuations)throw Error('完整封存包参数缺失');
  const canonical=fs.realpathSync(root),stat=fs.lstatSync(canonical);
  if(!stat.isDirectory()||(stat.mode&0o077)!==0)throw Error('封存批次目录必须私有');
  const receiptFile=path.join(canonical,`company-${opts.sourceCompanyId}.receipt.json`),receiptStat=fs.lstatSync(receiptFile);
  if(!receiptStat.isFile()||receiptStat.isSymbolicLink()||(receiptStat.mode&0o077)!==0)throw Error('封存凭据必须为私有普通文件');
  const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
  if(receipt.format!==1||receipt.phase!=='sealed and reread; not a cutover approval'||receipt.sourceCompanyId!==opts.sourceCompanyId||typeof receipt.sourceAdapter!=='string'||!(/^[A-Za-z0-9_-]+\.cjs$/).test(receipt.sourceAdapter)||receipt.sourceAdapter==='sealed-adapter.cjs')throw Error('封存凭据未完成核对');
  const {migrationSoftwareFingerprint}=require('@kudesi/api/dist/migration/software-fingerprint');
  const sourceAdapter=path.join(__dirname,receipt.sourceAdapter);
  if(migrationSoftwareFingerprint(sourceAdapter)!==receipt.softwareFingerprint)throw Error('封存后的迁移程序发生变化，必须重新读取核对来源');
  const env=require('@kudesi/api/dist/config/env').loadEnv(),Crypto=require('@kudesi/api/dist/common/crypto.service').CryptoService;
  const {readSealedArchive,sealedSourceHash}=require('@kudesi/api/dist/migration/sealed-source');
  const archive=await readSealedArchive(path.join(canonical,`company-${opts.sourceCompanyId}`),new Crypto(env.encryptionKeys,env.encryptionActiveKeyId),receipt.sha256,{sourceCompanyId:opts.sourceCompanyId,softwareFingerprint:receipt.softwareFingerprint});
  if(sealedSourceHash(archive)!==receipt.sourceHash)throw Error('封存内容与已核对凭据不一致');
  return archive;
};
