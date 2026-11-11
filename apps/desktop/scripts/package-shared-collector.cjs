'use strict';

const {copyFileSync,mkdirSync}=require('node:fs');
const path=require('node:path');

const collectorRoot=process.argv[2];
if(!collectorRoot)throw new Error('请提供小白 AI 客服的 jushuitan-collector 目录');
const root=path.join(__dirname,'..');
const dest=path.resolve(collectorRoot,'src','oa-aftersales');
for(const file of [
  'server/oa-aftersales.cjs','build/navigation.json','src/security.cjs','src/after-sales-query.cjs',
  'src/extractor.cjs','src/after-sales-panels.cjs','src/jushuitan-session.cjs','src/jushuitan-recording-status.cjs','src/request-watch.cjs',
]){
  const output=path.join(dest,file);
  mkdirSync(path.dirname(output),{recursive:true});
  copyFileSync(path.join(root,file),output);
}
