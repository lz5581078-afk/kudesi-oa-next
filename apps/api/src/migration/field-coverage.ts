import type { LegacyArchive,LegacyWorkflowSource } from './protocol';
import { sourceRowHash } from './source-rows';
import { workflowRowIdentity } from './workflow-row-identity';

type State='verified-native'|'needs-native-verification'|'not-read'|'no-source-data'|'no-company-data';
interface Field {column:string;type:string|null;state:State;originalRetained:boolean|null;destination:string|null;proof:string|null;reason:string|null}
export interface FieldCoverage {
  version:1;scope:string;tables:Array<{table:string;totalRows:string;companyRowsRead:number|null;originalRows:number;fields:Field[]}>;
  totals:{tables:number;columns:number;verifiedColumns:number;pendingColumns:number;unretainedColumns:number;verifiedCells:string};
}
interface Policy {proof:string;destination:string;type:RegExp}
const policies=new Map<string,Policy>();
const integer=/^(?:bigint|int)(?:\(\d+\))?(?: unsigned)?$/i,text=/^(?:varchar|char)\([1-9]\d*\)$/i;
for(const [column,destination]of Object.entries({id:'legacy_import_links → position_duties.id',position_id:'position_duties.position_id',category:'position_duties.category / description (原分类)',title:'position_duties.title',description:'position_duties.description',frequency:'position_duties.frequency',related_module:'position_duties.related_module'}))policies.set('position_responsibilities.'+column,{proof:'position-responsibility-duplicate-view',destination,type:['id','position_id'].includes(column)?integer:text});
for(const [column,destination]of Object.entries({company_id:'resource_records.company_id (来源公司映射)',product_id:'legacy_import_links → finance-products.id',name_key:'finance-products.giftShortName 派生索引',code_key:'finance-products.giftCodeShortName 派生索引'}))policies.set('finance_product_gift_aliases.'+column,{proof:'gift-alias-index-view',destination,type:column==='company_id'?integer:text});
for(const [column,destination]of Object.entries({last_recharge_at:'phones.lastRechargeAt',next_recharge_at:'phones.nextRechargeAt',recharge_cycle:'phones.rechargeCycleDays'}))policies.set('phone_numbers.'+column,{proof:'phone-recharge-view',destination,type:column==='recharge_cycle'?text:/^date$/i});
const fail=()=>Object.assign(Error('来源字段覆盖清单结构或范围无效'),{name:'LegacyDataError'});

/** A retained raw column is not proof of a usable native field. Policies name
 * real domain verifiers; counts must cover every source row in this company.
 * Unknown fields stay pending, including fields on a table already being read.
 * There are no business values or secrets in this report. */
export function sourceFieldCoverage(sourceRows:LegacyArchive['sourceRows'],verified:Record<string,number>,workflow?:LegacyWorkflowSource):FieldCoverage|undefined{
  const inventories=(sourceRows??[]).filter(r=>r.table==='legacy_schema_inventory'&&r.key==='current');
  if(!inventories.length)return undefined; // Full CLI separately requires this inventory; partial core fixtures do not claim full coverage.
  if(inventories.length!==1||inventories[0].row.version!==1||!Array.isArray(inventories[0].row.tables)||!inventories[0].row.tables.length)throw fail();
  const raw=new Map<string,Map<string,Record<string,unknown>>>();
  const all=[...(sourceRows??[])];
  for(const [table,rows]of Object.entries(workflow?.tables??{}))for(const row of rows)all.push({table,key:workflowRowIdentity(table,row),row});
  for(const row of all){
    if(typeof row.key!=='string'||!row.key||!row.row||typeof row.row!=='object'||Array.isArray(row.row))throw fail();
    if(!raw.has(row.table))raw.set(row.table,new Map());const values=raw.get(row.table)!,old=values.get(row.key);
    if(old&&sourceRowHash(old)!==sourceRowHash(row.row))throw fail();values.set(row.key,row.row);
  }
  const result:FieldCoverage={version:1,scope:'本公司范围的字段验收；原文留存不等于原生可用，仍须全公司汇总行归属与统一切换验收',tables:[],totals:{tables:0,columns:0,verifiedColumns:0,pendingColumns:0,unretainedColumns:0,verifiedCells:'0'}};
  const names=new Set<string>();let cells=0n;
  for(const table of inventories[0].row.tables){
    if(!table||typeof table.table!=='string'||!table.table||names.has(table.table)||typeof table.totalRows!=='string'||!/^\d+$/.test(table.totalRows)||typeof table.readInCompanyScope!=='boolean'||!Array.isArray(table.fields)||!table.fields.length)throw fail();names.add(table.table);
    const count=table.companyRowsRead;
    if(table.readInCompanyScope?(!Number.isSafeInteger(count)||count<0||BigInt(count)>BigInt(table.totalRows)):count!==null)throw fail();
    const rows=[...(raw.get(table.table)?.values()??[])].map(r=>r.ownership==='position.department'&&r.source_row&&typeof r.source_row==='object'&&!Array.isArray(r.source_row)?r.source_row as Record<string,unknown>:r);
    const fields:Field[]=[],fieldNames=new Set<string>(),ordinals=new Set<number>();
    for(const field of table.fields){
      if(!field||typeof field.name!=='string'||!field.name||fieldNames.has(field.name)||!Number.isSafeInteger(field.ordinal)||field.ordinal<1||ordinals.has(field.ordinal))throw fail();fieldNames.add(field.name);ordinals.add(field.ordinal);
      const type=typeof field.type==='string'?field.type:null,policy=policies.get(table.table+'.'+field.name);
      let state:State,originalRetained:boolean|null=null,reason:string|null=null;
      if((table.totalRows==='0'||count===0)&&rows.length){state='needs-native-verification';originalRetained=false;reason='清单声明无记录但实际原文非空，须核对范围';}
      else if(table.totalRows==='0')state='no-source-data';
      else if(!table.readInCompanyScope){state='not-read';originalRetained=false;reason='该表尚未按公司读取，字段原文及原生落点均待处理';}
      else if(count===0)state='no-company-data';
      else{
        originalRetained=rows.length===count&&rows.every(r=>Object.hasOwn(r,field.name)&&r[field.name]!==undefined&&(type?.toLowerCase()!=='json'||r[field.name]===null||(typeof r[field.name]==='string'&&(r[field.name] as string).trim().length>0)));
        const complete=policy&&type&&policy.type.test(type)&&Number.isSafeInteger(verified[policy.proof])&&verified[policy.proof]===count;
        state=originalRetained&&complete?'verified-native':'needs-native-verification';
        if(!originalRetained)reason='原文行数/字段不完整，或JSON已先解析；不能凭读取声明验收';
        else if(!policy)reason='原文已保留，尚无该字段的原生/历史读取验收规则';
        else if(!complete)reason='字段类型或实际业务回读证明未覆盖本公司全部来源行';
      }
      if(state==='verified-native'){result.totals.verifiedColumns++;cells+=BigInt(count);}
      if(state==='not-read'||state==='needs-native-verification')result.totals.pendingColumns++;
      if(originalRetained===false)result.totals.unretainedColumns++;
      result.totals.columns++;fields.push({column:field.name,type,state,originalRetained,destination:state==='verified-native'?policy!.destination:null,proof:state==='verified-native'?policy!.proof:null,reason});
    }
    if([...ordinals].some(n=>n>table.fields.length))throw fail();
    const extras=new Set(rows.flatMap(r=>Object.keys(r).filter(k=>!fieldNames.has(k))));
    for(const column of [...extras].sort()){
      result.totals.columns++;result.totals.pendingColumns++;fields.push({column,type:null,state:'needs-native-verification',originalRetained:true,destination:null,proof:null,reason:'原文出现清单外字段，须核对结构变化或适配器注释，不能默默忽略'});
    }
    result.tables.push({table:table.table,totalRows:table.totalRows,companyRowsRead:count,originalRows:rows.length,fields});
  }
  const virtual=new Set(['legacy_schema_inventory','legacy_position_workspace_policy','legacy_verification_policy','legacy_verification_reports']);
  if([...raw.keys()].some(t=>!names.has(t)&&!virtual.has(t)))throw fail();
  result.totals.tables=result.tables.length;result.totals.verifiedCells=cells.toString();return result;
}
