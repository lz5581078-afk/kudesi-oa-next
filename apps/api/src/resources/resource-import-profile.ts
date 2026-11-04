import { getResourceDef, scaledDecimal, sumUnitCents, unitOptionFromText, unitYuanText, yuanToPreciseCents } from '@kudesi/shared';
import type { ImportValue, ResourceImportProfile, ResourceImportStep } from '@kudesi/shared';

export interface ProfileSheetInput { name:string; headers?:string[]; rows:Array<Record<string,string>> }
export interface ProfileIssue { sheet:string; row:number; field:string; message:string }
export interface ProfileRecord { id:number; type:string; title:string; status:string; data:Record<string,unknown> }
export interface ProfileLookup {
  find(resource:string, fields:Record<string,unknown>, any?:{fields:readonly string[];value:string}):Promise<ProfileRecord[]>;
}
export interface ProfileAliases { [namespace:string]:Map<string,ProfileRecord> }
export interface PreparedProfileRow { line:number; source:Record<string,string>; input:Record<string,unknown>; status?:string; errors:string[] }
export const nonEmptyProfileRow=(row:Record<string,string>)=>!!row && typeof row==='object' && !Array.isArray(row) && Object.values(row).some(value=>String(value ?? '').trim()!=='');
export const profileStepAccepts=(step:ResourceImportStep,row:Record<string,string>)=>nonEmptyProfileRow(row) && (step.where ?? []).every(filter=>{const value=String(row[filter.column] ?? '').trim();return (!filter.in || filter.in.includes(value)) && (!filter.nonEmpty || !!value) && (!filter.empty || !value);});
const blank=(value:unknown)=>value===undefined || value===null || value==='';
const key=(values:unknown[])=>JSON.stringify(values.map(value=>String(value ?? '').trim().toLocaleLowerCase('zh-CN')));

export function validateProfileWorkbook(profile:ResourceImportProfile,sheets:ProfileSheetInput[]):ProfileIssue[] {
  const issues:ProfileIssue[]=[];const names=new Set<string>();let count=0;
  for(const sheet of sheets){
    if(names.has(sheet.name))issues.push({sheet:sheet.name,row:0,field:'',message:'工作表名称重复'});names.add(sheet.name);
    const definition=profile.sheets.find(item=>item.name===sheet.name);
    if(!definition){if(sheet.name!=='说明')issues.push({sheet:sheet.name,row:0,field:'',message:'该工作表不属于此导入模块'});continue;}
    count+=sheet.rows.filter(nonEmptyProfileRow).length;
    const headers=sheet.headers ?? [...new Set(sheet.rows.flatMap(row=>Object.keys(row)))];
    if(new Set(headers).size!==headers.length)issues.push({sheet:sheet.name,row:1,field:'',message:'工作表列名重复'});
    const unexpected=headers.filter(header=>!definition.headers.includes(header));
    if(unexpected.length)issues.push({sheet:sheet.name,row:1,field:unexpected[0],message:`不认识的列：${unexpected.join('、')}`});
    sheet.rows.forEach((row,index)=>{
      if(row && typeof row==='object' && !Array.isArray(row) && nonEmptyProfileRow(row) && !profile.steps.filter(step=>step.sheet===sheet.name).some(step=>profileStepAccepts(step,row)))issues.push({sheet:sheet.name,row:index+2,field:'',message:'该行类型没有可执行的导入步骤'});
      if(row && typeof row==='object' && Object.keys(row).some(name=>!definition.headers.includes(name)))issues.push({sheet:sheet.name,row:index+2,field:'',message:'数据行含模板以外的列'});
      if(!row || typeof row!=='object' || Array.isArray(row) || Object.values(row).some(value=>typeof value!=='string'))issues.push({sheet:sheet.name,row:index+2,field:'',message:'单元格必须为文字；请保留表格原值并重新读取'});
    });
  }
  for(const definition of profile.sheets)if(!definition.optional && !names.has(definition.name))issues.push({sheet:definition.name,row:0,field:'',message:`缺少工作表“${definition.name}”`});
  if(!count)issues.push({sheet:'',row:0,field:'',message:'工作簿中没有可导入数据'});
  if(count>profile.maxRows)issues.push({sheet:'',row:0,field:'',message:`整份工作簿最多导入${profile.maxRows}行`});
  return issues;
}

async function readValue(expression:ImportValue,row:Record<string,string>,sheets:ProfileSheetInput[],lookup:ProfileLookup,aliases:ProfileAliases,today:string):Promise<unknown> {
  if(Object.prototype.hasOwnProperty.call(expression,'literal'))return expression.literal;
  if(expression.today)return today;
  if(expression.when){const raw=String(row[expression.when.column] ?? '').trim();return readValue(expression.when.nonEmpty ? (raw ? expression.when.then : expression.when.otherwise) : (raw===expression.when.equals ? expression.when.then : expression.when.otherwise),row,sheets,lookup,aliases,today);}
  if(expression.firstOf){for(const item of expression.firstOf){const value=await readValue(item,row,sheets,lookup,aliases,today);if(!blank(value))return value;}return undefined;}
  if(expression.related){
    const relation=expression.related;const owner=row[relation.ownerColumn];
    const candidates=(sheets.find(sheet=>sheet.name===relation.sheet)?.rows ?? []).filter(child=>key([child[relation.childColumn]])===key([owner]));
    const chosen=relation.prefer ? candidates.find(child=>relation.prefer!.in.includes(String(child[relation.prefer!.column] ?? '').trim())) ?? candidates[0] : candidates[0];
    return chosen ? readValue(relation.value,chosen,sheets,lookup,aliases,today) : undefined;
  }
  if(expression.reference){
    const reference=expression.reference;const fields:Record<string,unknown>={};
    for(const [field,source]of Object.entries(reference.fields ?? {})){const value=await readValue(source,row,sheets,lookup,aliases,today);if(value!==undefined)fields[field]=value;}
    const value=reference.value ? await readValue(reference.value,row,sheets,lookup,aliases,today) : undefined;
    if(reference.value && blank(value))return null;
    if(!Object.keys(fields).length && !reference.anyFields?.length)return undefined;
    const declaredCode=reference.aliasValue ? await readValue(reference.aliasValue,row,sheets,lookup,aliases,today) : fields.code;
    const aliased=reference.namespace && !blank(declaredCode) ? aliases[reference.namespace]?.get(key([declaredCode])) : undefined;
    if(reference.importedOwner && !aliased)throw new Error('找不到主表中的所属资料');
    const matches=aliased && aliased.type===reference.resource && Object.entries(fields).filter(([field])=>field!=='code').every(([field,expected])=>typeof expected==='string' ? key([aliased.data[field]])===key([expected]) : aliased.data[field]===expected) ? [aliased] : await lookup.find(reference.resource,fields,reference.anyFields && value!==undefined ? {fields:reference.anyFields,value:String(value)} : undefined);
    const allowed=reference.activeOnly===false ? matches : matches.filter(item=>!['disabled','deleted','inactive','archived'].includes(item.status));
    if(!allowed.length && reference.optionalMissing)return null;
    if(allowed.length!==1)throw new Error(`${getResourceDef(reference.resource)?.label ?? '资料'}引用${allowed.length?'存在重名，无法确定':'不存在或已停用'}：${String(value ?? declaredCode ?? Object.values(fields).join('/'))}`);
    return reference.returnField ? allowed[0].data[reference.returnField] : allowed[0].id;
  }
  const names=[expression.column ?? '',...(expression.aliases ?? [])];
  const found=names.find(name=>Object.prototype.hasOwnProperty.call(row,name));
  let value:unknown=found===undefined ? undefined : String(row[found]).trim();
  if(blank(value))value=expression.fallback;
  if(blank(value)){if(expression.required)throw new Error(`${expression.column ?? '字段'}必填`);return value;}
  if(expression.map){const mapped=expression.map[String(value)];if(mapped===undefined)throw new Error(`${expression.column}“${value}”不在可选项里`);value=mapped;}
  const text=String(value);
  switch(expression.transform){
    case 'upper':return text.toUpperCase();
    case 'number':{const n=Number(text);if(!Number.isFinite(n))throw new Error(`${expression.column}不是有效数字`);return n;}
    case 'money':{try{return yuanToPreciseCents(text);}catch{throw new Error(`${expression.column}金额最多保留元小数点后6位`);}}
    case 'kg-to-g':{if(!/^\d+(?:\.\d{1,6})?$/.test(text))throw new Error(`${expression.column}公斤重量必须非负且最多六位小数`);const result=Number(scaledDecimal(text,6))/1000;if(!Number.isSafeInteger(Math.round(result*1000)))throw new Error(`${expression.column}重量过大`);return result;}
    case 'boolean':{if(['1','true','是','必选','启用','正常','yes','active'].includes(text.toLowerCase()))return true;if(['0','false','否','不必选','停用','no','inactive'].includes(text.toLowerCase()))return false;throw new Error(`${expression.column}应填写是或否`);}
    case 'unit':{const units=await lookup.find('finance-product-units',expression.unitKind?{kind:expression.unitKind}:{}, {fields:['name','code'],value:text});const codes=[...new Set(units.filter(unit=>unit.status==='active').map(unit=>String(unit.data.code || '')))];if(codes.length===1 && codes[0])return codes[0];if(codes.length>1)throw new Error(`${expression.column}单位存在重名编码，无法确定`);if(expression.unitKind)throw new Error(`${expression.column}单位不存在：${text}`);const unit=unitOptionFromText(text);if(!unit)throw new Error(`${expression.column}单位不存在：${text}`);return unit.value;}
    default:return value;
  }
}

export async function prepareProfileStep(profile:ResourceImportProfile,step:ResourceImportStep,sheets:ProfileSheetInput[],lookup:ProfileLookup,aliases:ProfileAliases,today:string):Promise<PreparedProfileRow[]> {
  const source=sheets.find(sheet=>sheet.name===step.sheet);
  let rows:Array<{row:Record<string,string>;line:number;errors?:string[]}>=(source?.rows ?? []).map((row,index)=>({row,line:index+2})).filter(({row})=>profileStepAccepts(step,row));
  if(step.aggregate){
    const groups=new Map<string,typeof rows>();for(const item of rows){const id=key(step.aggregate.groupBy.map(column=>item.row[column]));groups.set(id,[...(groups.get(id) ?? []),item]);}
    rows=[...groups.values()].map(group=>{const row={...group[0].row};const errors:string[]=[];for(const column of step.aggregate!.sumMoney){try{const values=group.map(item=>yuanToPreciseCents(item.row[column]));if(values.some(value=>value<0))throw new Error('金额必须非负');row[column]=unitYuanText(sumUnitCents(values));}catch(error){errors.push(`${column}：${(error as Error).message}`);}}const description=step.aggregate!.descriptions;if(description)row[description.target]=group.map(item=>`${item.row[description.name]}：${item.row[description.amount]}`).join('；');return {row,line:group[0].line,errors};});
  }
  const result:PreparedProfileRow[]=[];const seen=new Map<string,Record<string,unknown>>();
  for(const {row,line,errors:initialErrors} of rows){
    const input:Record<string,unknown>={};const errors:string[]=[...(initialErrors ?? [])];
    for(const [field,expression] of Object.entries(step.fields))try{const value=await readValue(expression,row,sheets,lookup,aliases,today);if(value!==undefined)input[field]=value;}catch(error){errors.push(`${expression.column ?? field}：${(error as Error).message}`);}
    let status:string | undefined;if(step.status)try{const value=await readValue(step.status,row,sheets,lookup,aliases,today);if(!blank(value))status=String(value);}catch(error){errors.push(`状态：${(error as Error).message}`);}
    if(step.deduplicate?.length && !errors.length){const id=key(step.deduplicate.map(field=>input[field]));const previous=seen.get(id);if(previous){if(JSON.stringify(previous)!==JSON.stringify(input))errors.push('同一自然键出现冲突资料');else continue;}else seen.set(id,input);}
    result.push({line,source:row,input,status,errors});
  }
  return result;
}

export function bindProfileAlias(step:ResourceImportStep,row:Record<string,string>,saved:ProfileRecord,aliases:ProfileAliases) {
  if(!step.namespace)return;
  const candidates=[step.namespace.columns.map(column=>row[column]),...(step.namespace.savedFields ? [step.namespace.savedFields.map(field=>saved.data[field])] : [])];
  const namespace=aliases[step.namespace.name] ??=new Map();
  for(const values of candidates){
    if(values.every(blank))continue;
    const id=key(values);const previous=namespace.get(id);
    if(previous && previous.id!==saved.id)throw new Error('文件内来源自然键重复');namespace.set(id,saved);
  }
}
