import { sourceFieldCoverage } from './field-coverage';
import type { LegacyArchive } from './protocol';
type Rows=NonNullable<LegacyArchive['sourceRows']>;
const inventory=(table:string,fields:string[],count=1,type='date',read=true,total=String(count)):Rows=>[{table:'legacy_schema_inventory',key:'current',row:{version:1,tables:[{table,totalRows:total,readInCompanyScope:read,companyRowsRead:read?count:null,fields:fields.map((name,i)=>({name,ordinal:i+1,type,nullable:'YES',primary:false}))}]}}];
describe('来源全字段验收账',()=>{
  it('只有完整原文和覆盖全部来源行的真实业务证明才能验收；写入计数不冒充证明',()=>{
    const rows=[...inventory('phone_numbers',['last_recharge_at','next_recharge_at']),{table:'phone_numbers',key:'1',row:{last_recharge_at:null,next_recharge_at:'2026-12-31'}}];
    expect(sourceFieldCoverage(rows,{phones:1})!.totals).toMatchObject({verifiedColumns:0,pendingColumns:2});
    expect(sourceFieldCoverage(rows,{'phone-recharge-view':2})!.totals.pendingColumns).toBe(2);
    const result=sourceFieldCoverage(rows,{'phone-recharge-view':1})!;
    expect(result.totals).toMatchObject({verifiedColumns:2,pendingColumns:0,verifiedCells:'2'});
    expect(JSON.stringify(result)).not.toContain('2026-12-31');expect(result.tables[0].fields[0].destination).toBe('phones.lastRechargeAt');
  });
  it('已读表的新增字段、改类型或缺失原文保持待验收，不能因该表曾迁入而放行',()=>{
    const rows=[...inventory('phone_numbers',['last_recharge_at','future_field']),{table:'phone_numbers',key:'1',row:{last_recharge_at:null,future_field:'private-fixture-value'}}];
    const r=sourceFieldCoverage(rows,{'phone-recharge-view':1})!;expect(r.totals).toMatchObject({verifiedColumns:1,pendingColumns:1});expect(JSON.stringify(r)).not.toContain('private-fixture-value');
    expect(sourceFieldCoverage([...inventory('phone_numbers',['last_recharge_at'],1,'datetime'),rows[1]],{'phone-recharge-view':1})!.totals.verifiedColumns).toBe(0);
    expect(sourceFieldCoverage(inventory('phone_numbers',['last_recharge_at']),{'phone-recharge-view':1})!.tables[0].fields[0].originalRetained).toBe(false);
  });
  it('JSON原文文本、JSON null、SQL NULL与空串不混为已完成原生字段；已解析对象须重读',()=>{
    for(const payload of ['{"amount":9007199254740993}','null',null,'""']){
      const r=sourceFieldCoverage([...inventory('a_table',['payload'],1,'json'),{table:'a_table',key:'1',row:{payload}}],{})!;
      expect(r.tables[0].fields[0]).toMatchObject({originalRetained:true,state:'needs-native-verification'});
    }
    for(const payload of [{amount:1},''])expect(sourceFieldCoverage([...inventory('a_table',['payload'],1,'json'),{table:'a_table',key:'1',row:{payload}}],{})!.tables[0].fields[0].originalRetained).toBe(false);
  });
  it('空库和本公司无行分别注明；不将全局大表行数转为不安全Number或任意分给公司',()=>{
    expect(sourceFieldCoverage(inventory('a_table',['id'],0),{})!.tables[0].fields[0].state).toBe('no-source-data');
    expect(sourceFieldCoverage(inventory('a_table',['id'],0,'bigint',true,'8'),{})!.tables[0].fields[0].state).toBe('no-company-data');
    const r=sourceFieldCoverage(inventory('a_table',['id'],0,'bigint',false,'90071992547409930'),{})!;
    expect(r.tables[0].totalRows).toBe('90071992547409930');expect(r.tables[0].fields[0].state).toBe('not-read');expect(r.totals.pendingColumns).toBe(1);
  });
  it('拒绝矛盾清单、重复字段/顺序、相同身份不同原文；同一证据重复引用不增加原行数',()=>{
    const rows=[...inventory('phone_numbers',['last_recharge_at']),{table:'phone_numbers',key:'1',row:{last_recharge_at:null}}];
    expect(sourceFieldCoverage([...rows,rows[1]],{'phone-recharge-view':1})!.tables[0].originalRows).toBe(1);
    expect(()=>sourceFieldCoverage([...rows,{...rows[1],row:{last_recharge_at:'2027-01-01'}}],{})).toThrow('清单');
    const bad=inventory('a_table',['id','id']);expect(()=>sourceFieldCoverage(bad,{})).toThrow('清单');
    const impossible=inventory('a_table',['id'],2,'int',true,'1');expect(()=>sourceFieldCoverage(impossible,{})).toThrow('清单');
    expect(sourceFieldCoverage([...inventory('a_table',['id'],0),{table:'a_table',key:'1',row:{id:1}}],{})!.totals.pendingColumns).toBe(1);
    const extra=sourceFieldCoverage([...inventory('a_table',['id']),{table:'a_table',key:'1',row:{id:1,new_column:'not-ignored'}}],{})!;expect(extra.tables[0].fields.map(f=>f.column)).toEqual(['id','new_column']);expect(extra.totals.pendingColumns).toBe(2);
    expect(sourceFieldCoverage([],{})).toBeUndefined();
    expect(()=>sourceFieldCoverage([...rows,{table:'missing_table',key:'1',row:{id:1}}],{})).toThrow('清单');
  });
  it('流程独立来源也计入原文留存，沿用相同复合身份，不误报未留存或重复计数',()=>{
    const row={company_id:3,template_id:1,node_key:'review'},workflow={companyId:3,tables:{workflow_timeout_policies:[row]}};
    const rows=inventory('workflow_timeout_policies',['company_id','template_id','node_key'],1,'varchar(100)');
    const result=sourceFieldCoverage(rows,{},workflow)!;expect(result.tables[0].originalRows).toBe(1);expect(result.totals).toMatchObject({pendingColumns:3,unretainedColumns:0});
    expect(sourceFieldCoverage([...rows,{table:'workflow_timeout_policies',key:JSON.stringify([3,1,'review']),row}],{},workflow)!.tables[0].originalRows).toBe(1);
    expect(()=>sourceFieldCoverage(rows,{}, {companyId:3,tables:{constructor:[{}]}})).toThrow('复合身份');
  });
});
