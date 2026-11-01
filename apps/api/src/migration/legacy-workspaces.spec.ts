const {projectWorkspaces}=require('../../../../scripts/migration/legacy-workspaces.cjs');
describe('只在迁移时解析旧岗位工作台',()=>{
  const policy={templates:['blank','finance','operations','content_manager'],legacyBindings:[{name:'财务',template:'finance'},{name:'主管',department:'短视频',template:'content_manager'}]};
  const departments=[{id:1,name:'短视频'},{id:2,name:'其他部门'}];
  it('显式值优先，包括显式空白/未知值；只对NULL使用旧精确绑定',()=>{
    const rows=projectWorkspaces([
      {id:1,name:'财务',department_id:1,workspace_template_key:null},
      {id:2,name:'财务',department_id:1,workspace_template_key:'operations'},
      {id:3,name:'财务',department_id:1,workspace_template_key:'blank'},
      {id:4,name:'财务',department_id:1,workspace_template_key:'unknown'},
      {id:5,name:'财务助理',department_id:1,workspace_template_key:null},
      {id:6,name:'主管',department_id:1,workspace_template_key:null},
      {id:7,name:'主管',department_id:2,workspace_template_key:null},
    ],departments,policy,'a'.repeat(64));
    expect(rows.map((r:any)=>r.legacyWorkspaceResolution.templateKey)).toEqual(['finance','operations','blank','blank','blank','content_manager','blank']);
    expect(rows[0].workspace_template_key).toBeNull();
    expect(rows[0].legacyWorkspaceResolution).toMatchObject({originalTemplateKey:null,via:'legacy-binding'});
  });
  it('不修改原始行，也不跨部门补猜',()=>{
    const source={id:1,name:'主管',department_id:2,workspace_template_key:null};
    const result=projectWorkspaces([source],departments,policy,'b'.repeat(64));
    expect(result[0]).not.toBe(source);expect(source).not.toHaveProperty('legacyWorkspaceResolution');
    expect(result[0].legacyWorkspaceResolution.templateKey).toBe('blank');
    expect(()=>projectWorkspaces([{...source,department_id:3}],departments,policy,'b'.repeat(64))).toThrow('所属部门');
  });
});
