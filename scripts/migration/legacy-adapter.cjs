/** Server-only source adapter. Source credentials and business values stay in process memory. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const rules = require('./mapping-rules.json');
const productMapping = require('./product-mapping.cjs');
const skuMapping = require('./sku-mapping.cjs');
const { readWorkflowSource } = require('./workflow-source.cjs');
const { collectSourceRows } = require('./source-row-catalog.cjs');
const { readSourceCoverage, uncoveredSourceTables } = require('./source-coverage.cjs');
const { readLegacyAssignments, readCurrentSkuAssignments } = require('./legacy-assignments.cjs');
const { readLegacyVerification } = require('./legacy-verification.cjs');
const { readLegacyWorkspaces } = require('./legacy-workspaces.cjs');
/** 直播管理的旧表（全部带 company_id，由通用公司范围读取；只读） */
const LIVE_TABLES=['live_commission_rule_versions','live_schedules','live_sessions','live_session_products','live_session_reports','live_session_orders','live_commission_records','live_wage_records','live_settlements','live_settlement_lines','live_settlement_refunds'];
const legacyError=(message)=>{const error=new Error(message);error.name='LegacyDataError';return error;};
const snake = (s) => s.replace(/[A-Z]/g, (c) => '_'+c.toLowerCase());
const ref = (type,id) => id===null||id===undefined||id===''?undefined:{legacyRef:{type,id:String(id)}};
const json = (v) => typeof v==='string'?JSON.parse(v):v;
const qi = (s) => {if(!/^[a-zA-Z0-9_]+$/.test(s))throw Error('Unsafe identifier');return '`'+s+'`';};
function exactCents(value, scale=0) {
  if(value===null||value===undefined||value==='')return undefined;
  const m=/^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if(!m||/[1-9]/.test((m[3]||'').slice(2+scale)))throw Error('金额精度超出新字段范围');
  const v=BigInt(m[2])*10n**BigInt(scale+2)+BigInt(((m[3]||'')+'0'.repeat(2+scale)).slice(0,2+scale));
  if(v>99999999999n*10n**BigInt(scale))throw Error('金额超出目标范围');return Number(v)*(m[1]?-1:1)/10**scale;
}
function kgToG(value){if(value===null||value===undefined||value==='')return undefined;const m=/^(\d+)(?:\.(\d{0,6}))?$/.exec(String(value));if(!m)throw Error('重量格式待核对');return Number(BigInt(m[1])*1000000n+BigInt(((m[2]||'')+'000000').slice(0,6)))/1000;}
function itemsAt(value,expression) {
  let current=[{value,ancestors:[]}];
  for(const part of expression.replace(/^\$\.?/,'').split('.').filter(Boolean)) {
    const array=part.endsWith('[]'), key=part.replace(/\[\]$/,'');
    const next=[];
    for(const x of current){const v=key?x.value?.[key]:x.value;if(array){if(Array.isArray(v))for(const item of v)next.push({value:item,ancestors:[...x.ancestors,x.value]});}else if(v!==undefined)next.push({value:v,ancestors:x.ancestors});}
    current=next;
  }
  return current;
}
function scope(table,cols,company) {
  if(table==='companies')return {sql:'t.id=?',args:[company]};
  if(['license_borrow_records','license_usage_records'].includes(table)&&cols.includes('license_id'))return {sql:'EXISTS(SELECT 1 FROM business_licenses l WHERE l.id=t.license_id AND l.company_id=?)',args:[company]};
  // 旧岗位条目的 company_id 与所属岗位的公司不一致（真实库里全是 1，岗位却在公司 3），归属以岗位所在部门的公司为准
  if(table==='position_duties')return {sql:'EXISTS(SELECT 1 FROM positions p JOIN departments d ON d.id=p.department_id WHERE p.id=t.position_id AND d.company_id=?)',args:[company]};
  if(cols.includes('company_id'))return {sql:'t.company_id=?',args:[company]};
  if(['employees','positions'].includes(table))return {sql:'EXISTS(SELECT 1 FROM departments d WHERE d.id=t.department_id AND d.company_id=?)',args:[company]};
  if(['employee_positions','employee_roles','employee_permission_overrides','employee_responsibility_groups','employee_workforce_profiles'].includes(table))return {sql:'EXISTS(SELECT 1 FROM employees e JOIN departments d ON d.id=e.department_id WHERE e.id=t.employee_id AND d.company_id=?)',args:[company]};
  if(['position_permissions','position_responsibilities'].includes(table))return {sql:'EXISTS(SELECT 1 FROM positions p JOIN departments d ON d.id=p.department_id WHERE p.id=t.position_id AND d.company_id=?)',args:[company]};
  if(table==='responsibility_group_items')return {sql:'EXISTS(SELECT 1 FROM responsibility_groups p WHERE p.id=t.group_id AND p.company_id=?)',args:[company]};
  return null;
}
exports.read=async ({sourceCompanyId,definitions,parseWeightScope,preserveCostHistory=false,preserveLegacyStates=false,includeWorkflowContinuations=false})=>{
  const app=process.env.LEGACY_APP_DIR;if(!app||!path.isAbsolute(app))throw Error('LEGACY_APP_DIR required');
  const req=createRequire(path.join(app,'package.json'));const env=req('dotenv').parse(fs.readFileSync(path.join(app,'.env')));
  const codec=req(path.join(app,'server/core/business-secrets.js')).createBusinessSecretCodec({primarySecret:env.SECRET_KEY||env.SESSION_SECRET||env.JWT_SECRET});
  const c=await req('mysql2/promise').createConnection({host:env.MYSQL_HOST||'127.0.0.1',port:Number(env.MYSQL_PORT||3307),user:env.MYSQL_USER||'oa_user',password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE||'ecommerce_oa',dateStrings:true});
  const out={company:null,departments:[],positions:[],employees:[],employeePositions:[],positionPermissions:[],employeeOverrides:[],positionDuties:[],compensationRecords:[],records:[],links:[],exclusions:[]};
  const businessDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const tables={};const locators=new Map();let locatorN=0;
  const excluded=(type,id,reason)=>out.exclusions.push({type,id:String(id),reason});
  const add=(type,id,data,status,extra={})=>out.records.push({type,id:String(id),data:Object.fromEntries(Object.entries(data).filter(([,v])=>v!==undefined&&v!==null&&v!=='')),status,...extra});
  try{
    await c.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.query('SET SESSION TRANSACTION READ ONLY');await c.beginTransaction();
    const [cols]=await c.query('SELECT TABLE_NAME t,COLUMN_NAME c,COLUMN_KEY pk,ORDINAL_POSITION ordinal,COLUMN_TYPE type,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
    const selected=new Set([...LIVE_TABLES,...(preserveLegacyStates?['sales_snapshots','finance_entries','finance_product_data_verification_events','finance_bundle_data_verifications','finance_bundle_data_verification_events','finance_product_bundle_boms','finance_product_gift_aliases']:[]),'companies','departments','positions','employees','employee_positions','employee_permission_overrides','position_permissions','position_duties','employee_compensation_records','resource_media','finance_product_archive_photos','finance_product_archive_costs',...Object.values(rules.resources).flatMap(x=>x.tables)]);
    if(preserveLegacyStates)selected.add('oa_feishu_bindings');
    for(const table of selected){const cs=cols.filter(x=>x.t===table).map(x=>x.c);if(!cs.length)continue;const own=scope(table,cs,sourceCompanyId);if(!own){excluded(table,'all','未核实公司归属，不读取记录');continue;}const uses=Object.values(rules.resources).filter(x=>x.tables.includes(table));const onlyExcluded=!preserveLegacyStates&&uses.length&&uses.every(x=>x.policy);tables[table]=(await c.query(`SELECT ${onlyExcluded?(cs.includes('id')?'t.id':'t.company_id id'):'t.*'} FROM ${qi(table)} t WHERE ${own.sql}`,own.args))[0];}
    // 总位置曾由旧启动脚本无公司条件地补为 A-02；只核对所引用的位置，不迁入其他公司的柜位。
    const foreignLicenseLocations=new Map();
    if(preserveLegacyStates){
      const ids=[...new Set((tables.business_licenses||[]).map(r=>r.location_id).filter(id=>id&&!((tables.company_locations||[]).some(l=>String(l.id)===String(id)))) )];
      if(ids.length){const [rows]=await c.query(`SELECT t.id,t.company_id,t.code FROM ${qi('company_locations')} t WHERE t.id IN (${ids.map(()=>'?').join(',')})`,ids);for(const row of rows)if(String(row.company_id)!==String(sourceCompanyId))foreignLicenseLocations.set(String(row.id),row);}
    }
    out.company=(tables.companies||[])[0];if(!out.company)throw Error('Company not found');out.company={id:Number(out.company.id),name:out.company.name};
    for(const [k,t] of [['departments','departments'],['positions','positions'],['employees','employees'],['employeePositions','employee_positions'],['positionPermissions','position_permissions'],['employeeOverrides','employee_permission_overrides'],['positionDuties','position_duties'],['compensationRecords','employee_compensation_records']])out[k]=tables[t]||[];
    out.employeePositions=out.employeePositions.filter(x=>!x.ended_at&&(!x.status||x.status==='active'));
    if(preserveLegacyStates)out.feishuBindings=tables.oa_feishu_bindings||[];
    const neededFeeCategories=new Set();for(const shared of tables.finance_shared_archives||[]){if(shared.archive_type!=='expenses')continue;const data=json(shared.data_json);for(const item of data.items||[]){if(item.status==='deleted')continue;for(let id of [item.categoryId,...(item.categoryIds||[])]){const seen=new Set();while(id&&!seen.has(String(id))){seen.add(String(id));neededFeeCategories.add(String(id));id=(data.categories||[]).find(x=>String(x.id)===String(id))?.parentId;}}}}
    const defs=new Map(definitions.map(d=>[d.key,d]));
    const byId=(table,id)=>(tables[table]||[]).find(x=>String(x.id)===String(id));
    const brandMap=new Map();
    for(const p of tables.finance_products||[]){const name=String(p.brand||'').trim();if(!name||brandMap.has(name))continue;const dictionary=(tables.finance_product_code_dictionary||[]).find(x=>x.dictionary_type==='brand'&&x.item_name===name);const id='brand:'+name;brandMap.set(name,id);add('finance-brands',id,{name,code:dictionary?.item_code},'active');}
    for(const d of tables.finance_product_code_dictionary||[]){if(d.dictionary_type!=='brand'||d.status!=='active'||brandMap.has(String(d.item_name).trim()))continue;const name=String(d.item_name).trim(),id='brand:'+name;brandMap.set(name,id);add('finance-brands',id,{name,code:d.item_code},'active');}
    // 商品档案单位与规格：旧三张单位表 + 档案里用到的包装类别、尺寸单位，建成新的公司级列表（必须排在商品档案前面，商品里存的是编码）
    const platformOrder=productMapping.nonnegativeSortRanks(tables.finance_sales_platforms||[]);
    const unitCatalog=productMapping.buildUnitCatalog({tables,defs:definitions,payloadOf:p=>{try{return json(p.payload_json||{})||{};}catch{return {};}}});
    if(defs.has('finance-product-units'))for(const r of unitCatalog.records)add('finance-product-units',r.id,r.data,'active');
    if(defs.has('finance-categories'))out.records.push(...productMapping.bundleCategoryRecords(tables));
    const scenarioMap=new Map();
    for(const b of tables.finance_product_bundle_codes||[]){const name=String(b.sales_scenario||'').trim();if(!name||scenarioMap.has(name))continue;const direct=(tables.finance_bundle_sales_scenarios||[]).find(x=>x.scenario_name===name||x.name===name);const id=direct?.id||'scenario:'+name;scenarioMap.set(name,id);add('finance-scenarios',id,{name:({standard:'标准',supply_chain:'供应链'})[name]||name,code:direct?.scenario_code||direct?.code||name,segment:({standard:'',supply_chain:'GYL'})[name]??direct?.scenario_code??direct?.code??name},'active');}
    // 旧系统外购成品：供货方式不是供应商 OEM 的（含空）都算原装采购（旧 normalizePurchasedSupplyMode）；分类树按 supplyModeScope / productCodeCategoryScope 分两棵（旧 purchasedCategoryScope）
    const productFamily=p=>p.archive_key==='purchased'?(p.supply_mode==='supplier_oem'?'supplier_oem':'original_purchase'):p.archive_key;
    const purchasedCategoryScope=c=>{const pl=json(c.payload_json||{})||{};return pl.supplyModeScope==='supplier_oem'||pl.productCodeCategoryScope==='supplier_oem'?'supplier_oem':'original_purchase';};
    const categoryFamilies=new Map();
    for(const p of tables.finance_products||[]){let id=p.category_id;const seen=new Set();while(id&&!seen.has(String(id))){seen.add(String(id));if(!categoryFamilies.has(String(id)))categoryFamilies.set(String(id),new Set());categoryFamilies.get(String(id)).add(productFamily(p));id=byId('finance_product_categories',id)?.parent_id;}}
    const categoryKey=(id,family)=>id===null||id===undefined||id===''?undefined:String(id)+':'+family;
    const archiveTypes={raw:'raw',self_made:'self_made',package:'package',oem_package:'oem_package',shipping_material:'shipping_material',purchased:'purchased'};
    function sourceValue(row,payload,field,rule){
      const names=[...(rule.aliases?.[field.key]||rules.commonAliases[field.key]||[]),field.key,snake(field.key)];
      for(const n of names){
        if(n.startsWith('@json:')){const expression=n.slice(6);const base=rule.json?.path||'$';if(expression.startsWith(base+'.')){const key=expression.slice(base.length+1);if(!key.includes('.')&&payload?.[key]!==undefined)return payload[key];}continue;}
        if(n.startsWith('@'))continue;
        if(row[n]!==undefined&&row[n]!==null&&row[n]!=='')return row[n];
        if(payload?.[n]!==undefined&&payload[n]!==null&&payload[n]!=='')return payload[n];
      }
      return undefined;
    }
    function convert(field,value,rule){
      if(value===undefined||value===null||value==='')return undefined;
      if(field.type==='secret'||field.type==='sensitive')return codec.decrypt(String(value));
      if(field.type==='money')return exactCents(value,field.scale??0);
      if(field.type==='ref')return ref(field.ref,value);
      if(field.type==='refs')return Array.isArray(value)?value.map(x=>ref(field.ref,x)):undefined;
      if(field.type==='files')return undefined;
      if(field.type==='date')return String(value).slice(0,10);
      if(['number','decimal'].includes(field.type))return Number(value);
      if(field.type==='bool'){if([true,1,'1','true','是','启用'].includes(value))return true;if([false,0,'0','false','否','停用'].includes(value))return false;throw Error('布尔值口径不明');}
      if(field.type==='select'){
        const aliases=rule?.valueMaps?.[field.key]||{};const v=aliases[value]||value;
        const option=field.options?.find(x=>x.value===v||x.label===value);return option?option.value:String(value);
      }
      if(field.type==='attrs')return typeof value==='string'?json(value):value;
      if(typeof value==='object')throw Error('复杂来源需专项转换');
      return String(value);
    }
    const mediaMap={qualification:'qualifications',license:'licenses',store:'stores',phone:'phones',trademark:'trademarks'};
    function filesFor(type,id,row,rule){
      const fspec=[];const def=defs.get(type);
      for(const f of def.fields.filter(x=>x.type==='files')){
        const candidates=[];const columns=(rule.aliases?.[f.key]||[]).filter(x=>!x.startsWith('@'));columns.push(snake(f.key),f.key);
        for(const col of columns)if(typeof row[col]==='string'&&row[col])candidates.push({value:row[col],name:row.attachment_name||`${f.label}.bin`,id:col});
        for(const m of tables.resource_media||[]){if(mediaMap[m.resource_type]===type&&String(m.resource_id)===String(id)&&columns.some(col=>col===m.field_key||col===snake(String(m.field_key)))){const target=f.key.toLowerCase();if(target.includes('attachment')||target.includes('photo')||target.includes('image'))candidates.push({value:m.storage_path,name:m.original_name||`${f.label}.bin`,id:'media:'+m.id,sha:m.sha256});}}
        if(type==='workforce'){const cat=({contractFiles:'contract',identityFiles:'identity',paymentFiles:'payment',qualificationFiles:'qualification',otherFiles:'other'})[f.key];for(const a of tables.employee_workforce_attachments||[])if(String(a.employee_id)===String(id)&&a.category===cat)candidates.push({value:a.storage_path,name:a.file_name,id:'wfatt:'+a.id,sha:a.sha256});}
        if(type==='finance-products'&&f.key==='photos')for(const p of tables.finance_product_archive_photos||[])if(String(p.product_id)===String(id))candidates.push({value:p.data_url,name:p.file_name||'商品照片.bin',id:'photo:'+p.id});
        const chosen=candidates.some(x=>String(x.id).startsWith('media:'))?candidates.filter(x=>String(x.id).startsWith('media:')):candidates;
        for(const item of chosen){const locator=String(++locatorN);locators.set(locator,item);fspec.push({field:f.key,id:item.id,name:item.name,locator});}
      }
      return fspec;
    }
    const composedLines=[];
    for(const [type,rule] of Object.entries(rules.resources)){
      if(type==='finance-bundle-naming-rules'){const mapped=skuMapping.namingRules(tables,categoryKey,categoryFamilies);out.records.push(...mapped.records);out.exclusions.push(...mapped.exclusions);continue;}
      if(!defs.has(type)||['finance-brands','finance-scenarios','finance-bundle-lines','finance-product-boms','finance-product-units','finance-base-code-lines'].includes(type))continue;
      const def=defs.get(type);
      if(rule.policy){
        // 完整替换模式已由 stores 分支逐字段迁入资金登记，不能仍报整类未迁。
        if(type==='store-funds'&&preserveLegacyStates)continue;
        for(const r of tables[rule.tables[0]]||[])excluded(type,r.id||'snapshot',rule.reason||rule.policy);continue;
      }
      let entries=[];
      for(const row of (tables[rule.tables[0]]||[]).filter(x=>!rule.filter||Object.entries(rule.filter).every(([k,v])=>String(x[k])===String(v)))){
        if(rule.json){if(rule.json.kind&&row.archive_type!==rule.json.kind)continue;const value=json(row[rule.json.column]);for(const x of itemsAt(value,rule.json.path))entries.push({row:rule.json.path==='$'?row:x.value,payload:x.value,ancestors:x.ancestors,container:row});}
        else entries.push({row,payload:{},ancestors:[],container:row});
      }
      if(type==='finance-categories')entries=entries.flatMap(x=>[...(categoryFamilies.get(String(x.row.id))||new Set([x.row.archive_key==='purchased'?purchasedCategoryScope(x.row):x.row.archive_key]))].map(family=>({...x,row:{...x.row,__family:family,__sourceId:x.row.id,id:categoryKey(x.row.id,family)}})));
      // Native latest-cost ordering uses target IDs as a tie-breaker, so preserve
      // the source primary-key order explicitly rather than relying on SELECT order.
      if(type==='finance-product-costs'&&preserveCostHistory)entries.sort((a,b)=>{const x=BigInt(a.row.id),y=BigInt(b.row.id);return x<y?-1:x>y?1:0;});
      for(const {row,payload,ancestors,container} of entries){
        const id=row.id??(type==='workforce'?row.employee_id:undefined)??row.category_id??container.id??'default';
        const archivedRow=Boolean(row.archived_at)&&row.status!=='deleted';
        if((row.status==='deleted'||(row.status==='archived'&&!archivedRow))&&!(type==='finance-fee-categories'&&neededFeeCategories.has(String(id)))){excluded(type,id,'旧系统已删除或归档，不作为在用资料迁入');continue;}
        const data={};let aliasName,sourceLocationOmission;const notices=[];
        const translateStatus=(raw)=>{let st=rule.statusMap?.[raw]??raw;if(['normal','active',undefined,null,''].includes(st))st=def.statuses.find(x=>x.value==='active')?'active':def.defaultStatus;else if(st==='inactive')st=def.statuses.find(x=>x.value==='inactive')?'inactive':def.statuses.find(x=>x.value==='disabled')?'disabled':st;const t=def.statuses.find(s=>s.value===st||s.label===st);return t?t.value:st;};
        const money=(field,value)=>{try{return exactCents(value,def.fields.find(f=>f.key===field)?.scale??0);}catch{const msg=field+'：旧金额精度超出新字段允许范围，未舍入，待核对';notices.push(msg);excluded(type+'.'+field,id,msg);return undefined;}};
        try{
          for(const field of def.fields){if(field.readonly||field.type==='files'||(type==='asset-categories'&&field.key==='customFields')||(type==='fixed-assets'&&['config','attrs'].includes(field.key))||(type==='finance-products'&&['rawFinishedNames','zeroValueReason','capacities','purchasePrice','freight','handlingFee','brandId','supplierId','weightG','categoryId'].includes(field.key)))continue;data[field.key]=convert(field,sourceValue(row,payload,field,rule),rule);}
          let status=rule.statusMap?.[row.status]??row.status;
          if(['finance-base-codes','finance-bundles'].includes(type))status='pending';
          else if(['normal','active',undefined,null,''].includes(status))status=def.statuses.find(x=>x.value==='active')?'active':def.defaultStatus;
          else if(status==='inactive')status=def.statuses.find(x=>x.value==='inactive')?'inactive':def.statuses.find(x=>x.value==='disabled')?'disabled':status;
          if(['stores','phones'].includes(type)&&row.abnormal_reason){const table=type==='stores'?'store_abnormal_reasons':'phone_abnormal_reasons';const matches=(tables[table]||[]).filter(x=>x.reason===row.abnormal_reason);if(matches.length===1)data.abnormalReason=ref(type==='stores'?'store-abnormal-reasons':'phone-abnormal-reasons',matches[0].id);else{delete data.abnormalReason;data.note=[data.note,'旧异常说明：'+row.abnormal_reason].filter(Boolean).join('\n');excluded(type+'.abnormalReason',id,'旧异常原因未唯一对应新原因目录，原文已保留在备注');}}
          if(type==='tax-profiles'&&!row.license_id&&row.taxpayer_no){const licenses=(tables.business_licenses||[]).filter(x=>x.credit_code===row.taxpayer_no);if(licenses.length===1)data.licenseId=ref('licenses',licenses[0].id);}
          if(type==='finance-platforms')data.sortOrder=platformOrder.get(String(id));
          if(type==='licenses'){
            data.category=row.license_category;
            const location=foreignLicenseLocations.get(String(row.location_id));
            if(location?.code==='A-02'){
              sourceLocationOmission={row,location};delete data.locationId;
              const notice='旧总位置引用了其他公司的 A-02 默认位置，未作为真实保管位置迁入；原始引用已加密留档，分项位置按原记录保留，空缺位置需核对。';
              notices.push(notice);excluded('licenses.locationId',id,notice);
            }
          }
          if(type==='stores'&&row.platform==='抖店')data.platform='douyin';
          if(type==='archives'){
            const related={business_license:['license','licenseId','licenses'],license:['license','licenseId','licenses'],store:['store','storeId','stores'],bank_account:['bank_account','bankAccountId','bank-accounts'],fixed_asset:['fixed_asset','fixedAssetId','fixed-assets'],partner_profile:['partner_profile','partnerId','partners'],trademark:['trademark','trademarkId','trademarks'],qualification:['qualification','qualificationId','qualifications'],tax_profile:['tax_profile','taxProfileId','tax-profiles']}[row.related_type];
            if(related){data.relatedType=related[0];if(row.related_id)data[related[1]]=ref(related[2],row.related_id);}
          }
          if(type==='workforce'){
            // 旧兼职档案没有自己的状态/姓名/用工类型：取自员工表；附件按分类放进五个附件字段
            const emp=byId('employees',row.employee_id);
            if(!emp)throw Error('复杂来源需专项转换：兼职档案对应的员工不在迁入范围');
            data.userId=ref('user',row.employee_id);data.name=emp.name;
            data.employmentType=emp.employment_type==='temp'?'temp':'part_time';
            if(['inactive','disabled'].includes(emp.status))status='inactive';
            if(!data.contractStartDate){delete data.contractStartDate;notices.push('旧档案没有合作开始日期，待补');}
          }
          if(type==='license-borrows'&&!data.borrowerUserId)data.borrowerName='未登记（旧数据无借用人）';
          if(type==='bank-store-links'&&!data.purpose)data.purpose='店铺收款';
          if(type==='phones'){data.feeCycle=({'30':'monthly','90':'quarterly','365':'yearly'})[row.fee_cycle]||row.fee_cycle;data.forwardApp=row.has_forwarding_app===1?'yes':'no';}
          // 充值周期(天)：旧库 recharge_cycle 是 '30'/'90'/'365' 天数文字或 monthly/quarterly/yearly；新字段是天数。不认识的不猜，记入待核对
          if(type==='phones'&&data.rechargeCycleDays===undefined&&row.recharge_cycle!==undefined&&row.recharge_cycle!==null&&row.recharge_cycle!==''){const days=/^\d+$/.test(String(row.recharge_cycle))?Number(row.recharge_cycle):({monthly:30,quarterly:90,yearly:365})[String(row.recharge_cycle)];if(days>=1&&days<=3650)data.rechargeCycleDays=days;else notices.push('旧充值周期“'+row.recharge_cycle+'”不是天数，未迁入，待核对');}
          // 宽带使用区域：旧宽带只有位置文字时，文字与唯一一个区域位置同名才自动对上，否则文字保留在“位置说明”，不猜
          if(type==='broadband'&&!data.locationId&&data.locationNote){const hits=(tables.company_locations||[]).filter(x=>String(x.name).trim()===String(data.locationNote).trim()&&x.location_scope!=='archive');if(hits.length===1){data.locationId=ref('locations',hits[0].id);delete data.locationNote;}}
          if(type==='stores'){if([false,0,'0','no','未连接'].includes(row.jushuitan_connected))data.jushuitan='not_connected';if([true,1,'1','yes','已连接'].includes(row.jushuitan_connected))data.jushuitan='connected';}
          if(type==='stores'){
            // 绑定手机号：旧库是 手机号.store_id + 有效的“手机号-店铺”关联（一店可多号）。新系统由店铺的手机号档案字段承载：第一个进“手机号档案”，其余进“更多绑定手机号”，号码文本由保存规则按档案带出
            const phoneIds=[];const addPhone=v=>{if(v!==undefined&&v!==null&&!phoneIds.includes(String(v)))phoneIds.push(String(v));};
            for(const p of tables.phone_numbers||[])if(String(p.store_id)===String(row.id))addPhone(p.id);
            for(const l of tables.resource_links||[])if(l.relation_type==='phone_store'&&l.status==='active'&&!l.ended_at&&l.source_type==='phone_number'&&l.target_type==='store'&&String(l.target_id)===String(row.id))addPhone(l.source_id);
            if(phoneIds.length){data.phoneId=ref('phones',phoneIds[0]);if(phoneIds.length>1)data.phoneIds=phoneIds.slice(1).map(x=>ref('phones',x));}
            // 最后订单时间：新档案是“日期 + 时刻”两格，旧库精确到秒
            const clock=/^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2}(:\d{2})?)/.exec(String(row.last_order_at||''));
            if(clock&&!/^00:00(:00)?$/.test(clock[1]))data.lastOrderClock=clock[1];
          }
          if(type==='self-media'){
            // 手机号档案：账号上的手机号对不上档案时，用旧库“手机号-自媒体”关联补上
            if(!data.phoneId){const l=(tables.resource_links||[]).find(x=>x.relation_type==='phone_self_media'&&x.status==='active'&&!x.ended_at&&x.source_type==='phone_number'&&x.target_type==='self_media_account'&&String(x.target_id)===String(row.id));if(l){data.phoneId=ref('phones',l.source_id);const ph=byId('phone_numbers',l.source_id);if(ph&&ph.number&&!data.phoneNumber)data.phoneNumber=String(ph.number);}}
          }
          if(type==='locations'&&row.location_scope==='archive')data.scope='asset_space';
          if(type==='asset-categories'){const value=typeof row.custom_fields==='string'?json(row.custom_fields):row.custom_fields;data.customFields=Array.isArray(value)?value.map(x=>typeof x==='string'?x:x.label||x.name||x.key).join(','):undefined;}
          if(type==='fixed-assets'){const config=typeof row.configuration==='string'?json(row.configuration):row.configuration;if(config&&typeof config==='object'&&!Array.isArray(config)){/* 旧“配置”是按分类参数名存的 {CPU:'i5',内存:'16GB'}：对应新“分类自定义属性”，名称→内容；值不是文字的（对象/数组）保留成 JSON 文本，不丢 */const attrs={};for(const [k,v] of Object.entries(config)){if(v===null||v===undefined||v==='')continue;attrs[k]=typeof v==='object'?JSON.stringify(v):String(v);}if(Object.keys(attrs).length)data.attrs=attrs;}else if(config&&typeof config==='object'){data.config=JSON.stringify(config);}}
          if(type==='memos'){const isService=row.memo_type==='service';data.title=isService?(row.service_name||row.account_name||row.provider_name):(row.account_name||row.service_name||row.provider_name);if(!(isService&&row.service_name&&row.account_name))delete data.accountName;if(row.status==='active')status='normal';}
          if(type==='finance-fee-items'){if(row.direction==='支出'||!row.direction){data.direction='expense';if(!row.direction)notices.push('旧费用项目未显式记方向，按旧页面的默认支出规则转换');}if(row.direction==='冲减')data.direction='offset';if(row.direction==='往来')data.direction='current';if(['不限','不固定'].includes(row.defaultObject))delete data.defaultObject;else{const allowed=def.fields.find(f=>f.key==='defaultObject')?.options?.map(x=>x.value)||[];const raw=String(row.defaultObject||'').split(/[、,，]/).filter(Boolean);const mapped=raw.flatMap(x=>x==='公户'?['公司公户','店铺公户']:[x]);const missing=mapped.filter(x=>!allowed.includes(x));if(missing.length)excluded(type+'.defaultObject',id,'新系统不支持这些默认挂账节点，费用项目保留、这些节点未写入：'+missing.join('、'));data.defaultObject=mapped.filter(x=>allowed.includes(x)).join('、')||undefined;}}

          if(type==='finance-categories'){data.archiveType=row.__family;data.code=row.category_code;if(data.archiveType==='original_purchase'&&String(data.code).length>8&&String(data.code).startsWith('YZCG')){data.code=String(data.code).slice(4);excluded(type+'.code',id,'旧分类码'+row.category_code+'去掉已由采购方式表示的YZCG前缀，转换为'+data.code+'；基础/组合原码仍保留');}data.parentId=ref('finance-categories',categoryKey(row.parent_id,row.__family));}
          if(type==='finance-products'){
            data.archiveType=archiveTypes[row.archive_key];if(row.archive_key==='purchased')data.supplyMode=productFamily(row);data.categoryId=ref('finance-categories',categoryKey(row.category_id,productFamily(row)));data.brandId=ref('finance-brands',brandMap.get(String(row.brand||'').trim()));
            data.specQty=Number(row.amount);data.code=row.product_code;data.name=row.product_name;
            if(['package','oem_package'].includes(row.archive_key))Object.assign(data,skuMapping.packageWeight(row.weighing_weight,payload.weightUnit));else data.weightG=kgToG(row.weighing_weight);
            if(row.archive_key==='shipping_material'&&['g','kg','jin'].includes(String(payload.weightUnit||'').toLowerCase()))data.weightUnit=String(payload.weightUnit).toLowerCase();data.weightManual=Boolean(payload.weightManualCorrected);data.purchaseSpec=payload.purchaseSpecification;data.productPackagingSpec=payload.productPackagingSpecification;
            // 旧档案存的是单位/类别名称，新档案存编码：按旧单位表和用到的名称建成的列表转换（对不上的不猜）
            const unitFields=productMapping.productUnitFields({row,payload,catalog:unitCatalog});
            for(const key of ['productPackagingUnit','packagingCategory','dimensionUnit']){delete data[key];if(unitFields[key])data[key]=unitFields[key];else if(String(payload[key]||'').trim())notices.push(key+'：旧值“'+String(payload[key]).trim()+'”不在旧单位列表里，未迁入，待核对');}
            if(unitFields.specUnit)data.specUnit=unitFields.specUnit;
            if(Array.isArray(payload.capacities))data.capacities=payload.capacities.map(x=>typeof x==='string'?x:(x.value??x.amount??'')+(x.unit??'')).join('\n');
            if(!Number.isFinite(data.specQty)){const pricingCode=unitCatalog.codeOf(row.archive_key==='shipping_material'?'shipping_unit':'spec_unit',payload.purchaseSpecification);const pricingUnit=pricingCode?{value:pricingCode}:def.fields.find(f=>f.key==='specUnit').options.find(o=>o.label===payload.purchaseSpecification||o.value===payload.purchaseSpecification);if(pricingUnit){data.specQty=1;data.specUnit=pricingUnit.value;data.shape=[row.shape_style,String(row.amount||'')+String(row.unit||'')].filter(Boolean).join(' / ');notices.push('旧规格为尺寸描述，按原计价单位保留为一单位；尺寸见形态/款式');}}
            data.freight=money('freight',payload.freightAmount);data.handlingFee=money('handlingFee',payload.handlingAmount);
            const costs=(tables.finance_product_archive_costs||[]).filter(x=>String(x.product_id)===String(row.id)&&x.status==='active'&&(!x.effective_from||x.effective_from<=businessDay)&&(!x.effective_to||x.effective_to>=businessDay)).sort((a,b)=>String(b.effective_from).localeCompare(String(a.effective_from))||Number(b.id)-Number(a.id));
            const purchase=skuMapping.purchaseInput(row,payload,costs);if(purchase!==undefined)data.purchasePrice=money('purchasePrice',purchase);
            if(row.archive_key==='purchased'&&row.supply_mode==='supplier_oem'&&costs.find(x=>x.cost_type==='purchase')?.source_type==='production_bom')notices.push('OEM成本记录来源为生产BOM，汇总时不作为额外采购价重复加入');
            data.rawFinishedNames=Array.isArray(payload.rawFinishedNames)?payload.rawFinishedNames.map(x=>x.name).join('\n'):undefined;
            const zero=payload.zeroConfirmations||{};data.zeroValueReason=[['purchasePrice','采购价'],['freightAmount','运费'],['handlingAmount','装卸费']].filter(([k])=>zero[k]?.confirmed&&zero[k]?.reason).map(([k,label])=>label+'：'+zero[k].reason).join('\n');
            for(const [field,reasonKey] of [['purchasePrice','purchasePrice'],['freight','freightAmount'],['handlingFee','handlingAmount']]){if(data[field]===0&&!(zero[reasonKey]?.confirmed&&zero[reasonKey]?.reason)){delete data[field];notices.push(field+'：旧值为零但缺少确认理由，待核对');excluded(type+'.'+field,id,'旧零金额缺少确认理由，未伪造理由');}}
            for(const f of ['supplierId'])delete data[f];
          }
          if(type==='finance-base-codes'){
            const canonical=byId('finance_product_base_codes',row.canonical_base_code_id);
            const productId=row.source_product_id||canonical?.source_product_id;data.productId=ref('finance-products',productId);data.canonicalId=ref('finance-base-codes',row.canonical_base_code_id);
            data.codeChangeReason='迁移保留旧系统已有基础编码及款式编码';
            // 旧系统一个基础编码关联多个商品 = 多构成：新系统用“多构成”来源 + 构成行保留，不拆也不丢数量
            const composed=canonical?null:productMapping.composedFromLinks((tables.finance_product_code_links||[]).filter(l=>String(l.base_code_id)===String(row.id)));
            if(composed){
              const primary=byId('finance_products',composed.primaryProductId);
              if(!primary)throw Error('复杂来源需专项转换：多构成编码的主要商品不在迁入范围');
              const dictName=(id)=>(tables.finance_product_code_dictionary||[]).find(x=>String(x.id)===String(id))?.item_name;
              data.origin='composed';data.productId=ref('finance-products',primary.id);
              data.codeCategoryId=ref('finance-categories',categoryKey(primary.category_id,productFamily(primary)));
              if(String(primary.brand||'').trim())data.codeBrandId=ref('finance-brands',brandMap.get(String(primary.brand).trim()));
              if(row.spec_quantity!==null&&row.spec_quantity!==undefined)data.codeSpecQty=Number(row.spec_quantity);
              const specUnitName=dictName(row.spec_unit_dictionary_id);const specUnitCode=specUnitName&&unitCatalog.codeOf('spec_unit',specUnitName);
              if(specUnitCode)data.codeSpecUnit=specUnitCode;
              if(!data.varietyName){const v=dictName(row.variety_dictionary_id);if(v)data.varietyName=v;else{data.varietyName=String(row.product_name||'').slice(0,80);notices.push('多构成编码旧品种为空，暂按名称填，待核对');}}
              notices.push('多构成编码的分类、品牌按主要商品迁入，待核对');
              composedLines.push({baseId:String(row.id),lines:composed.lines});
            }
            if(canonical){const p=byId('finance_products',productId);const names=json(p?.payload_json||{}).rawFinishedNames||[];aliasName=names.find(x=>x.id===row.raw_finished_name_id)?.name;if(!aliasName)throw Error('马甲名称ID未对应到原料成品名');}
          }
          if(type==='finance-bundles'){
            data.configNo=skuMapping.configNo(data.configNo);
            data.scenarioId=ref('finance-scenarios',scenarioMap.get(String(row.sales_scenario||'').trim()));data.manualReason='迁移保留旧系统已有组合编码、名称及款式编码';
            const b=byId('finance_product_bundle_definitions',row.bundle_definition_id);const brand=(tables.finance_product_code_dictionary||[]).find(x=>String(x.id)===String(b?.brand_dictionary_id));if(brand)data.brandId=ref('finance-brands',brandMap.get(String(brand.item_name).trim()));if(b?.product_category_dictionary_id)data.bundleCategoryId=ref('finance-categories',`bundle-dict:${b.product_category_dictionary_id}`);if(b?.weight_mode==='manual'){data.weightMode='manual';data.manualWeightG=kgToG(b.weighing_weight);data.overrideReason='迁移保留旧系统手工重量';}
            if(preserveLegacyStates){
              const bom=byId('finance_product_bundle_boms',row.bom_id);
              if(!bom)throw legacyError('旧组合构成版本不存在');
              data.manualPropertiesValue=row.properties_value;data.baseUnit=b?.base_unit;
              if(typeof bom.version_no!=='string'||!bom.version_no||bom.version_no.length>16)throw legacyError('旧组合构成版本号无法对应');
              data.bomVersion=bom.version_no;
              data.bomEffectiveFrom=bom.effective_from;data.bomEffectiveTo=bom.effective_to;
              if(bom.remark)data.note=[data.note,'原BOM备注：'+bom.remark].filter(Boolean).join('\n');
              const variety=byId('finance_product_code_dictionary',b?.variety_dictionary_id);if(variety)data.varietyName=variety.item_name;
            }
          }
          if(type.startsWith('finance-express-')){
            if(type==='finance-express-branches')data.carrierId=ref('finance-express-carriers',ancestors.at(-1)?.id);
            if(type==='finance-express-versions')data.branchId=ref('finance-express-branches',ancestors.at(-1)?.id);
            if(['finance-express-prices','finance-express-fee-batches','finance-express-surcharges'].includes(type))data.versionId=ref('finance-express-versions',ancestors.at(-1)?.id);
            if(type==='finance-express-surcharges'&&data.weightMode==='between'&&data.weightStart===undefined&&String(row.weight_scope||'').trim()){
              const parsed=parseWeightScope(String(row.weight_scope));
              if(!parsed||parsed.end!==data.weightEnd||!parsed.startInclusive||!parsed.endInclusive)throw legacyError('重量范围与结构化字段不一致，未猜测加收起点');
              data.weightStart=parsed.start;notices.push('原起始重量空缺，按原重量范围文字恢复起点；未改变适用范围');
            }
            if(type==='finance-express-prices'){
              const raw=String(row.province||'');const geographic=raw.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市/g,'').trim();
              const allowed=def.fields.find(f=>f.key==='province').options;
              data.province=/^(全国|全部)$/.test(raw)?'ALL':geographic;
              if(!allowed.some(x=>x.value===data.province))throw Error('旧地区无法准确对应新省份，未扩大到上级省份：'+raw);
              const parsed=parseWeightScope(String(row.weight_scope||''));
              if(!parsed)throw Error('重量范围无法准确对应，未导入报价');
              data.shipWeightMin=row.range_start_weight!==null&&row.range_start_weight!==undefined?Number(row.range_start_weight):parsed.start;
              data.shipWeightMax=row.range_end_weight!==null&&row.range_end_weight!==undefined?Number(row.range_end_weight):parsed.end??undefined;
              data.minExclusive=!parsed.startInclusive;data.maxExclusive=!parsed.endInclusive;
              if(row.price_rule_type==='formula'){
                const first=String(row.first_weight_type??'1');if(!['0','1'].includes(first))throw Error('旧公式首重口径无效');
                data.firstWeight=Number(first);data.firstPrice=exactCents(row.first_weight_amount??row.base_amount,4);data.extraPrice=exactCents(row.continued_weight_amount,4);delete data.fixedPrice;
              }else{data.fixedPrice=exactCents(row.base_amount,4);delete data.firstPrice;delete data.extraPrice;}
            }
          }
          if(type==='finance-margins'){data.categoryId=row.category_id?ref('finance-categories',row.category_id):undefined;data.profitPercent=exactCents(row.profit_rate,6);data.reason='迁移保留旧系统现行利润率口径';}
          if(type==='bank-accounts'){data.kind=row.account_kind;if(!preserveLegacyStates){delete data.balance;excluded(type+'.balance',id,'余额不自动作为期初余额迁入');}else if(row.current_balance==null)excluded(type+'.balance',id,'旧余额未记录，不能当作已核实的零余额；原始行已留档');}
          if(type==='finance-express-fee-batches'&&['已导入','启用','已生效'].includes(row.status))status='active';
          if(type==='finance-fee-categories'&&row.status==='deleted'&&neededFeeCategories.has(String(id)))status='inactive';
          const translatedStatus=def.statuses.find(s=>s.value===status||s.label===status);if(translatedStatus)status=translatedStatus.value;
          const archive=archivedRow?{at:String(row.archived_at),by:row.archived_by?String(row.archived_by):undefined,reason:row.archive_reason?String(row.archive_reason):undefined,fromStatus:row.archived_from_status?translateStatus(row.archived_from_status):undefined}:undefined;
          add(type,id,data,status,{archive,sourceTaxRow:type==='tax-profiles'&&preserveLegacyStates?row:undefined,sourceLocationOmission,sourceAbnormalRow:preserveLegacyStates&&['stores','phones'].includes(type)&&row.status==='abnormal'&&!String(row.abnormal_reason||'').trim()?row:undefined,sourceCostRow:type==='finance-product-costs'&&preserveCostHistory?row:undefined,sourceUpdatedAt:type==='finance-product-sources'?row.updated_at:undefined,aliasName,notices,files:filesFor(type,id,row,rule)});
          // 店铺档案上的保证金/冻结/货款/推广余额在新系统不是可编辑字段（以资金快照为准）：旧值迁成一条“旧系统档案登记”快照
          if(type==='stores'){
            const fund={deposit:money('deposit',row.deposit_amount),frozen:money('frozen',row.frozen_amount),withdrawable:money('goodsFund',row.goods_payment_amount),promotion:money('promotionBalance',row.promotion_fee_balance)};
            if(Object.values(fund).some(v=>preserveLegacyStates?v!==undefined:Boolean(v))&&defs.has('store-funds')){
              const stamp=String(row.updated_at||'').slice(0,10);
              const validDate=/^\d{4}-\d{2}-\d{2}$/.test(stamp)&&Number.isFinite(Date.parse(stamp+'T00:00:00Z'))&&new Date(stamp+'T00:00:00Z').toISOString().slice(0,10)===stamp;
              if(preserveLegacyStates&&!validDate)excluded('store-funds',id,'旧店铺资金缺少有效档案更新时间，不能用迁移日编造统计日期；原始行已保留');
              else add('store-funds','legacy-store:'+id,{storeId:ref('stores',id),snapshotDate:validDate?stamp:businessDay,...fund,source:'legacy',note:preserveLegacyStates?'旧系统档案登记；原档案更新时间：'+String(row.updated_at):'旧系统档案登记'},'recorded');
            }
          }
        }catch(e){excluded(type,id,'字段转换待核对：'+(e instanceof SyntaxError?'来源结构不是合法JSON':/^(金额|马甲|旧地区|旧公式|重量|布尔|复杂)/.test(e.message)?e.message:e.name));}
      }
    }
    // 多构成基础编码的构成行：只给已成功转换的编码补行；主要商品行是第一行
    for(const c of composedLines){if(!out.records.some(r=>r.type==='finance-base-codes'&&r.id===c.baseId))continue;for(const l of c.lines)add('finance-base-code-lines',c.baseId+':'+l.id,{baseCodeId:ref('finance-base-codes',c.baseId),productId:ref('finance-products',l.productId),...l.data},'active');}
    // 商品构成依赖BOM表，不能把bom_id误当商品ID。
    for(const l of tables.finance_product_archive_bom_lines||[]){const bom=byId('finance_product_archive_boms',l.bom_id);if(!bom){excluded('finance-product-boms',l.id,'BOM父记录缺失');continue;}add('finance-product-boms',l.id,{productId:ref('finance-products',bom.owner_product_id),componentId:ref('finance-products',l.component_product_id),qty:Number(l.quantity),lossPercent:Number(l.loss_rate||0)},'active');}
    for(const l of tables.finance_product_archive_labor_lines||[]){const bom=byId('finance_product_archive_boms',l.bom_id);if(!bom){excluded('finance-product-boms','labor:'+l.id,'人工BOM父记录缺失');continue;}add('finance-product-boms','labor:'+l.id,{productId:ref('finance-products',bom.owner_product_id),laborId:ref('finance-labor-costs',l.labor_cost_item_id),qty:Number(l.quantity)},'active');}
    // 旧组合BOM被多个组合共用：按每个组合展开，保留每条马甲引用。
    for(const b of tables.finance_product_bundle_codes||[]){if(b.status==='deleted')continue;for(const l of (tables.finance_product_bundle_bom_lines||[]).filter(x=>String(x.bom_id)===String(b.bom_id))){let baseId=l.base_code_id;if(!baseId&&l.product_archive_id){const candidates=(tables.finance_product_base_codes||[]).filter(x=>String(x.source_product_id)===String(l.product_archive_id)&&!x.canonical_base_code_id&&x.status!=='deleted');if(candidates.length===1)baseId=candidates[0].id;}if(!baseId){excluded('finance-bundle-lines',`${b.id}:${l.id}`,'构成没有唯一有效基础编码，不猜引用');continue;}const base=l.component_type==='base_code'?byId('finance_product_base_codes',baseId):null;
      const product=l.product_archive_id?byId('finance_products',l.product_archive_id):null;
      const dictionary=byId('finance_product_code_dictionary',l.unit_dictionary_id);
      const unitName=String((base?base.base_unit:product?.unit)||dictionary?.item_name||json(l.component_snapshot||{}).unit||'').trim();
      const unit=unitName&&(unitCatalog.codeOf('spec_unit',unitName)||unitCatalog.codeOf('shipping_unit',unitName));
      if(unitName&&!unit){excluded('finance-bundle-lines',`${b.id}:${l.id}`,'组成原计量单位未对应公司单位目录，未使用默认值代替');continue;}
      add('finance-bundle-lines',`${b.id}:${l.id}`,{bundleId:ref('finance-bundles',b.id),baseCodeId:ref('finance-base-codes',baseId),role:l.role,qty:Number(l.quantity),...productMapping.bundleLineExtras(l,unit)},'active');}}
    for(const b of tables.finance_product_bundle_codes||[]){if(b.status==='deleted')continue;for(const l of (tables.finance_bundle_labor_lines||[]).filter(x=>String(x.bom_id)===String(b.bom_id)))add('finance-bundle-lines',`${b.id}:labor:${l.id}`,{bundleId:ref('finance-bundles',b.id),laborId:ref('finance-labor-costs',l.labor_item_id),role:'labor',qty:Number(l.quantity)},'active');}
    // 旧 resource_links 中没有落成字段/子资源的多对多关联，按手动关联迁入（商标授权店铺、账户店铺已是子资源，不在此列）。
    const linkSpecs={phone_store:['phone_number','store','phones','stores'],phone_license:['phone_number','business_license','phones','licenses'],phone_self_media:['phone_number','self_media_account','phones','self-media'],phone_wechat:['phone_number','wechat_account','phones','wechat'],partner_profile_license:['partner_profile','business_license','partners','licenses'],partner_profile_store:['partner_profile','store','partners','stores'],partner_bank:['partner_profile','bank_account','partners','bank-accounts'],self_media_store:['self_media_account','store','self-media','stores'],store_wechat:['store','wechat_account','stores','wechat'],account_service_license:['account_service_memo','business_license','memos','licenses'],account_service_store:['account_service_memo','store','memos','stores'],account_service_phone:['account_service_memo','phone_number','memos','phones'],license_operator:['business_license','employee','licenses','user']};
    out.links=[];
    for(const l of tables.resource_links||[]){
      const spec=linkSpecs[l.relation_type];if(!spec)continue;
      if(l.source_type!==spec[0]||l.target_type!==spec[1]){excluded('link.'+l.relation_type,l.id,'旧关联两端类型与该关联定义不符，未迁入');continue;}
      if(l.status!=='active'||l.ended_at){excluded('link.'+l.relation_type,l.id,'旧关联已终止，不迁入');continue;}
      const day=(v)=>v?String(v).slice(0,10):undefined;
      out.links.push({id:String(l.id),relation:l.relation_type,sourceType:spec[2],sourceId:String(l.source_id),targetType:spec[3],targetId:String(l.target_id),validFrom:day(l.valid_from),validTo:day(l.valid_to),purpose:l.purpose?String(l.purpose):undefined});
    }
    // 直播管理：原样交出旧行（金额仍是十进制元字符串），由迁移程序按整数分换算并校验引用；没有直播表的旧库得到空数组
    out.live=Object.fromEntries(LIVE_TABLES.map(t=>[t.replace(/^live_/,''),(tables[t]||[]).map(r=>({...r}))]));
    if(includeWorkflowContinuations){
      out.workflow=await readWorkflowSource(c,cols,sourceCompanyId);await readLegacyAssignments(c,out.workflow,app,req);await readCurrentSkuAssignments(c,out.workflow,app,req);out.workflow.catalog={dictionaries:tables.finance_product_code_dictionary||[]};
      // Snapshot the old read-only policy result. The new application's runtime
      // never infers a workspace or grants cost access from department names.
      const policyFile=path.join(app,'server/core/employee-profile.js');const before=fs.readFileSync(policyFile);const policy=req(policyFile);
      if(!before.equals(fs.readFileSync(policyFile)))throw legacyError('旧权限策略读取期间发生变化');
      out.workflow.access={policyHash:crypto.createHash('sha256').update(before).digest('hex'),employees:[]};
      for(const employee of out.employees){
        const active=employee.status==='active';const profile=active?await policy.loadEmployeeProfile({query:async(sql,args)=>(await c.query(sql,args))[0],companyId:sourceCompanyId,employeeId:employee.id,requireActive:true}):null;
        out.workflow.access.employees.push({employeeId:String(employee.id),canUseWorkflow:active,canViewCosts:active&&profile?.canViewCosts===true});
      }
    }
    if(preserveLegacyStates){
      const workspace=readLegacyWorkspaces(app,out.positions,out.departments);out.positions=workspace.positions;
      out.sourceRows=[...collectSourceRows(tables,cols,sourceCompanyId),...workspace.sourceRows,...await readLegacyVerification(c,app,sourceCompanyId,req,{tables,businessDay})];
      for(const row of tables.sales_snapshots||[]){
        add('store-daily-metrics','sales-snapshot:'+row.id,{storeId:ref('stores',row.store_id),day:row.stat_date,sales:exactCents(row.sales_amount),refund:exactCents(row.refund_amount),adCost:exactCents(row.ad_cost),platformFee:exactCents(row.platform_fee),purchaseCost:exactCents(row.purchase_cost),otherCost:exactCents(row.other_cost),source:'import'},'recorded');
      }
    }
    if(preserveLegacyStates){
      const inventory=await readSourceCoverage(c,cols,tables,out.workflow);
      out.sourceRows.push({table:'legacy_schema_inventory',key:'current',row:inventory});
      out.exclusions.push(...uncoveredSourceTables(inventory));
    }
    await c.rollback();
  }finally{await c.end();}
  out.loadFile=async(locator)=>{
    const item=locators.get(locator);if(!item)throw legacyError('附件定位不存在');let buffer;
    if(item.value.startsWith('data:')){const m=/^data:[^;,]+;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(item.value);if(!m)throw legacyError('附件内嵌格式不支持');buffer=Buffer.from(m[1],'base64');}
    else{const roots=[path.resolve(app,'..','uploads'),path.resolve(app,'uploads')];const raw=item.value.replace(/^\/uploads\//,'');const paths=[...roots.map(r=>path.resolve(r,raw)),path.resolve(app,item.value),path.resolve(app,'..',item.value),path.resolve(item.value)];let file=paths.find(p=>roots.some(r=>p.startsWith(r+path.sep))&&fs.existsSync(p)&&fs.statSync(p).isFile());if(!file)throw legacyError('附件本地文件未找到');file=fs.realpathSync(file);if(!roots.some(r=>file.startsWith(fs.realpathSync(r)+path.sep)))throw legacyError('附件路径越界');buffer=fs.readFileSync(file);}
    const digest=crypto.createHash('sha256').update(buffer).digest('hex');if((item.sha||item.contentHash)&&(item.sha||item.contentHash)!==digest)throw legacyError('附件摘要不一致');item.contentHash=digest;return buffer;
  };
  for(const r of out.records)for(const f of r.files||[]){try{const buffer=await out.loadFile(f.locator);f.contentHash=crypto.createHash('sha256').update(buffer).digest('hex');}catch{f.contentHash='unavailable';}}
  return out;
};
