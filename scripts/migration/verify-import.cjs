/** Read-only reconciliation; output has identifiers and failures, never account passwords or bank numbers. */
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {createRequire}=require('node:module');
const req=createRequire(path.join(process.cwd(),'package.json'));
const {DataSource}=req('typeorm');
const {buildDataSourceOptions,alignSessionTimeZone}=req(path.join(process.cwd(),'apps/api/dist/database/data-source'));
const {loadEnv}=req(path.join(process.cwd(),'apps/api/dist/config/env'));
const {CryptoService}=req(path.join(process.cwd(),'apps/api/dist/common/crypto.service'));
const {encodeLegacyPassword}=req(path.join(process.cwd(),'apps/api/dist/auth/password'));
const {RESOURCE_DEFS,yuanToPreciseCents}=req('@kudesi/shared');
const {parseWeightScope}=req(path.join(process.cwd(),'apps/api/dist/integrations/express-recognition'));
const hash=b=>createHash('sha256').update(b).digest('hex');
async function main(){
 const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
 const company=Number(arg('--company')),sourceCompanyId=Number(arg('--source-company'));
 if(!Number.isInteger(company)||company<1||!Number.isInteger(sourceCompanyId)||sourceCompanyId<1)throw Error('Invalid company');
 const applied=JSON.parse(fs.readFileSync(arg('--import-report'),'utf8'));
 const source=await require('./legacy-adapter.cjs').read({sourceCompanyId,definitions:RESOURCE_DEFS,parseWeightScope});
 const env=loadEnv(),crypto=new CryptoService(env.encryptionKeys,env.encryptionActiveKeyId);
 const ds=await alignSessionTimeZone(await new DataSource(buildDataSourceOptions()).initialize());
 try{
 await ds.query('SET SESSION TRANSACTION READ ONLY');
 const links=await ds.query('SELECT source_key,target_type,target_id FROM legacy_import_links WHERE company_id=? AND source_company_id=? AND source_system=?',[company,sourceCompanyId,'legacy-oa']);
 const ids=new Map(links.map(l=>[l.source_key,Number(l.target_id)]));
 const rows=await ds.query('SELECT id,type,data,status,secrets FROM resource_records WHERE company_id=?',[company]);
 const records=new Map(rows.map(r=>[Number(r.id),{...r,data:typeof r.data==='string'?JSON.parse(r.data):r.data}]));
 const people=await ds.query('SELECT * FROM users WHERE company_id=?',[company]);
 const files=await ds.query('SELECT * FROM resource_files WHERE company_id=?',[company]);
 const errors=[],check=(ok,type,id,field)=>{if(!ok)errors.push({type,id:String(id),field});};
 const label=r=>String(r?.data?.name||r?.data?.manualName||r?.data?.code||r?.data?.manualCode||r?.data?.title||r?.data?.companyName||r?.data?.storeName||r?.data?.itemName||'');
 const sourceMap=new Map(source.records.map(r=>[r.type+':'+r.id,r]));
 const skippedFields=new Set([...applied.failures,...applied.excluded].map(e=>e.type+':'+e.id));
 let refChecks=0,priceChecks=0,sensitiveChecks=0,fileChecks=0,aliasChecks=0;
 for(const r of source.records){
  const id=ids.get(r.type+':'+r.id);if(!id)continue;
  const target=records.get(id);check(target&&target.type===r.type,r.type,r.id,'target');if(!target)continue;
  const fields=RESOURCE_DEFS.find(d=>d.key===r.type)?.fields||[];
  for(const [k,v] of Object.entries(r.data)){
   const f=fields.find(f=>f.key===k);
   if(f?.showWhen&&!f.showWhen.in.includes(f.showWhen.field==='status'?target.status:target.data[f.showWhen.field])){if(v!==null&&v!==undefined&&v!=='')applied.excluded.push({type:r.type+'.'+k,id:r.id,reason:'新系统当前类型/状态不使用此字段，按新资料规则未写入'});continue;}
   if(skippedFields.has(r.type+'.'+k+':'+r.id)||skippedFields.has(r.type+'.duplicate.'+k+':'+r.id))continue;
   if(v?.legacyRef){refChecks++;check(target.data[k]===ids.get(v.legacyRef.type+':'+v.legacyRef.id),r.type,r.id,k);}
   if(f?.type==='money'&&(f.scale||0)>0&&r.type==='finance-product-sources'){priceChecks++;check(target.data[k]===v,r.type,r.id,k);}
   if(['sensitive','secret'].includes(f?.type)&&v){sensitiveChecks++;let equal=false;try{equal=crypto.decrypt(JSON.parse(target.secrets||'{}')[k])===v;}catch{}if(!equal&&links.filter(l=>l.target_type===r.type&&Number(l.target_id)===id).length>1){applied.excluded.push({type:r.type+'.duplicate.'+k,id:r.id,reason:'合并的同一资料敏感字段存在差异，保留首条值；未覆盖，需核对'});}else check(equal,r.type,r.id,k);}
  }
  if(r.type==='finance-base-codes'){
   check(target.data.code===r.data.code,r.type,r.id,'code');
   if(r.data.canonicalId){aliasChecks++;check(target.data.name===r.data.name,r.type,r.id,'name');}
  }
  if(r.type==='finance-bundles'){check(target.data.code===r.data.manualCode,r.type,r.id,'code');check(target.data.name===r.data.manualName,r.type,r.id,'name');}
  for(const f of r.files||[]){const fid=ids.get('file:'+r.type+':'+r.id+':'+f.field+':'+f.id);if(!fid)continue;const file=files.find(x=>Number(x.id)===fid);check(file&&file.resource_id===id,r.type,r.id,f.field+'.binding');if(!file)continue;
   check(Array.isArray(target.data[f.field])&&target.data[f.field].includes(fid),r.type,r.id,f.field+'.reference');
   let same=false;try{const storage=String(file.storage_key).replace(/^local:/,'');if(!/^oa\/[a-zA-Z0-9/.-]+$/.test(storage)||storage.includes('..'))throw Error();const buffer=fs.readFileSync(path.join(process.env.FILES_LOCAL_ROOT,storage));same=buffer.length===Number(file.size)&&hash(buffer)===hash(await source.loadFile(f.locator));}catch{}fileChecks++;check(same,r.type,r.id,f.field+'.digest');
  }
 }
 for(const e of source.employees){const p=people.find(p=>Number(p.id)===ids.get('user:'+e.id));check(!!p,'user',e.id,'missing');if(!p)continue;const account=String(e.login_account||'').trim()||null;check(p.account===account,'user',e.id,'account');check(p.status===(e.status==='active'?'active':'disabled'),'user',e.id,'status');check(p.password_hash===(account?encodeLegacyPassword(String(e.password_salt),String(e.password_hash)):'!no-login'),'user',e.id,'passwordHash');if(e.base_salary!==null&&e.base_salary!==undefined)check(Number(p.base_salary)===yuanToPreciseCents(String(e.base_salary),0),'user',e.id,'baseSalary');}
 const details=entries=>entries.map(e=>({...e,label:label(sourceMap.get(e.type+':'+e.id)||sourceMap.get(e.type.slice(0,e.type.lastIndexOf('.'))+':'+e.id))}));
 const counts={};for(const r of rows)counts[r.type]=(counts[r.type]||0)+1;
 const result={checkedAt:new Date().toISOString(),companyId:company,sourceFingerprint:applied.sourceFingerprint,checks:{sourceEmployees:source.employees.length,loginAccounts:source.employees.filter(e=>e.login_account).length,noLoginPeople:source.employees.filter(e=>!e.login_account).length,links:links.length,refChecks,priceChecks,sensitiveChecks,fileChecks,aliasChecks},counts,errors,failures:details(applied.failures),excluded:details(applied.excluded)};
 fs.writeFileSync(arg('--report'),JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({checks:result.checks,errors:errors.length}));if(errors.length)process.exitCode=1;
 }finally{await ds.destroy();}
}
main().catch(e=>{console.error('Reconciliation stopped:',e.name);process.exitCode=1;});
