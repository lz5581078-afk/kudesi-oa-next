import { FlowValues } from './FlowFields';

const SNAPSHOTS=new Set(['legacySkuPayload','legacySkuInspection','legacySkuResult','legacySkuSync','legacyDuplicateConfirmation']);
const LABELS:Record<string,string>={
  specName:'规格名称',note:'备注',lines:'商品组成',status:'原状态',baseUnit:'基本单位',shortName:'简称',versionNo:'版本',bundleName:'组合名称',laborLines:'人工组成',notRequired:'无需配置的项目',platformCodes:'销售平台',salesScenario:'销售场景',warehouseNote:'仓库备注',propertiesCode:'属性编码',weighingWeight:'原称重值',propertiesValue:'属性',brandManual:'手工指定品牌',brandDictionaryId:'原品牌编号',configurationCode:'配置编码',productCategoryDictionaryId:'原分类编号',reuseInfo:'沿用资料核对',
  baseCodeId:'原基础编码编号',componentType:'组成类型',displayName:'名称',includeInJstBundle:'上传聚水潭',isRequired:'是否必需',lossRate:'损耗率',quantity:'数量',role:'用途',sortOrder:'顺序',sourceCode:'原编码',laborItemId:'原人工编号',label:'标签',other:'其他物料',package:'包装',labor:'人工',platformId:'原平台编号',issues:'核对问题',laborKeys:'人工对应记录',lineKeys:'组成对应记录',sourceId:'沿用档案编号',sourceName:'沿用名称',sourceWeight:'原重量',statuses:'各项核对状态',targetWeight:'目标重量',
  source:'原人工资料',cost:'原单价',id:'原记录编号',name:'名称',unit:'单位',versionId:'原版本编号',platforms:'平台核对',conflict:'冲突说明',existing:'已有记录',finalCode:'最终编码',productName:'商品名称',sources:'构成核对记录',totalCost:'原核对总成本',weight:'原核对重量',bomId:'原构成编号',codes:'生成编码',syncStatus:'原同步状态',definitionId:'原组合档案编号',existingCodes:'已有编码',costTable:'原成本表关联',entries:'关联记录',skuCode:'SKU编码',finalStyleCode:'最终款式编码',mainStyleCode:'主款式编码',platformName:'平台名称',canonicalId:'原主编码编号',message:'原同步说明',actorId:'原确认人员编号',confirmedAt:'原确认时间',matches:'确认的重复编码',code:'编码',reason:'原确认理由',
};
const STATES:Record<string,string>={draft:'草稿',returned:'已退回',processing:'办理中',pending:'待处理',completed:'已完成',cancelled:'已取消',rejected:'已拒绝',verified:'已验证',active:'启用',inactive:'停用',done:'已完成',sent:'已发送',success:'成功',succeeded:'成功',failed:'失败',error:'失败',skipped:'已跳过',submitted:'已提交',approving:'审批中',finance_confirming:'财务确认中'};
const ACTIONS:Record<string,string>={pending:'待办理',submit:'提交',submitted:'已提交',approve:'审核通过',return:'退回',cancel:'取消',withdraw:'撤回',complete:'完成',finish:'完成'};
const ROLES:Record<string,string>={main:'主商品',gift:'赠品',package:'包装',label:'标签',other:'其他物料',labor:'人工',instruction:'说明书',base_code:'基础编码',product:'商品档案'};
export const legacyStatusLabel=(v:string)=>STATES[v]??v;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);

/** The API supplies only reviewed, permission-filtered snapshots. Render their
 * business labels and exact numeric text rather than exposing JSON field names. */
function SnapshotValue({value,kind='',depth=0}:{value:unknown;kind?:string;depth?:number}){
  if(value==null||value==='')return <span>—</span>;
  if(typeof value==='boolean')return <span>{value?'是':'否'}</span>;
  if(typeof value!=='object'){
    const text=String(value),label=kind==='status'?legacyStatusLabel(text):['role','componentType'].includes(kind)?ROLES[text]??text:text;
    return <span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{label}</span>;
  }
  if(depth>8)return <span>记录层级过深，请联系管理员核对</span>;
  if(Array.isArray(value)){
    if(!value.length)return <span>—</span>;
    if(value.every(object)){
      const columns=[...new Set(value.flatMap(row=>Object.keys(row)))];
      return <div className="table-scroll"><table><thead><tr>{columns.map(k=><th key={k}>{LABELS[k]??`原字段（${k}）`}</th>)}</tr></thead><tbody>{value.map((row,i)=><tr key={i}>{columns.map(k=><td key={k}><SnapshotValue value={row[k]} kind={k} depth={depth+1}/></td>)}</tr>)}</tbody></table></div>;
    }
    if(kind==='sources'&&value.every((row):row is unknown[]=>Array.isArray(row)&&row.length===2))return <div className="table-scroll"><table><thead><tr><th>原基础编码编号</th><th>原核对记录</th></tr></thead><tbody>{value.map((row,i)=><tr key={i}><td><SnapshotValue value={row[0]} depth={depth+1}/></td><td><SnapshotValue value={row[1]} depth={depth+1}/></td></tr>)}</tbody></table></div>;
    return <ul>{value.map((v,i)=><li key={i}><SnapshotValue value={v} kind={kind} depth={depth+1}/></li>)}</ul>;
  }
  const entries=Object.entries(value);
  if(!entries.length)return <span>—</span>;
  return <dl className="kv-grid">{entries.map(([k,v])=><div key={k}><dt>{LABELS[k]??`原字段（${k}）`}</dt><dd><SnapshotValue value={v} kind={k} depth={depth+1}/></dd></div>)}</dl>;
}

export function LegacyFlowValues(props:Parameters<typeof FlowValues>[0]){
  const snapshotField=(f:typeof props.fields[number])=>SNAPSHOTS.has(f.key)&&f.readonly===true&&f.group==='原SKU快照';
  const snapshots=props.fields.filter(f=>snapshotField(f)&&props.values[f.key]!=null);
  const historical=props.fields.some(f=>snapshotField(f)||['原流程','原节点','迁入前记录'].includes(f.group));
  const values={...props.values};
  if(historical&&typeof values.legacyStatus==='string')values.legacyStatus=legacyStatusLabel(values.legacyStatus);
  if(historical&&typeof values.legacyAction==='string')values.legacyAction=ACTIONS[values.legacyAction]??values.legacyAction;
  const fields=props.fields.filter(f=>!snapshotField(f));
  return <>
    {fields.length>0&&<FlowValues {...props} fields={fields} values={values}/>}
    {snapshots.map(f=>{
      let parsed=props.values[f.key];try{if(typeof parsed==='string')parsed=JSON.parse(parsed);}catch{/* Preserve an unexpected text value visibly. */}
      return <details key={f.key}><summary>{f.label}</summary><SnapshotValue value={parsed}/></details>;
    })}
  </>;
}
