'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const HASHES={
  'server/modules/workspaces/position-templates.js':'26c36e1596467427b4d130e8bba6e3bbad5e3b29ba74a84e29cb44efda4ef092',
  'shared/position-workspaces.json':'79ccb2c4da36f09b985b5581478725b432fae9f39da313c9fb2997709fd86c00',
};
/** Only the migration resolves the old exact-name/department binding. The new
 * application's runtime continues to use an explicit workspace_type. */
function projectWorkspaces(positions,departments,policy,policyHash){
  if(!Array.isArray(policy.templates)||!Array.isArray(policy.legacyBindings))throw Error('旧岗位工作台策略结构不合法');
  const templates=new Set(policy.templates);
  return positions.map(p=>{
    const department=departments.find(d=>String(d.id)===String(p.department_id));
    if(!department)throw Error('旧岗位所属部门未迁入');
    const explicit=p.workspace_template_key;
    const binding=explicit==null?policy.legacyBindings.find(r=>r.name===p.name&&(!r.department||r.department===department.name)):null;
    const templateKey=explicit!=null?(templates.has(explicit)?explicit:'blank'):(binding?.template||'blank');
    if(!templates.has(templateKey))throw Error('旧岗位工作台绑定引用未知模板');
    return {...p,legacyWorkspaceResolution:{originalTemplateKey:explicit??null,templateKey,policyHash,via:explicit!=null?'explicit':binding?'legacy-binding':'blank-fallback'}};
  });
}
function readLegacyWorkspaces(app,positions,departments){
  if(!positions.length)return {positions,sourceRows:[]};
  let policy;
  for(const [file,expected] of Object.entries(HASHES)){
    const bytes=fs.readFileSync(path.join(app,file));
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('旧岗位工作台策略已变化，须重新核对源码');
    if(file.endsWith('.json'))policy=JSON.parse(bytes.toString('utf8'));
  }
  const policyHash=crypto.createHash('sha256').update(JSON.stringify(HASHES)).digest('hex');
  const projected=projectWorkspaces(positions,departments,policy,policyHash);
  return {positions:projected,sourceRows:[{table:'legacy_position_workspace_policy',key:'current',row:{hashes:HASHES,policyHash,...policy,resolutions:projected.map(p=>({positionId:String(p.id),...p.legacyWorkspaceResolution}))}}]};
}
module.exports={projectWorkspaces,readLegacyWorkspaces};
