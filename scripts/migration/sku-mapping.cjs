/** Map explicit old archive→code-category links; do not guess from names. */
const json = v => typeof v === 'string' ? JSON.parse(v || '{}') : v || {};
exports.configNo=v=>/^V?\d{1,3}$/i.test(String(v||''))?String(v).replace(/^V/i,'').padStart(2,'0'):String(v||'01');
exports.packageWeight=(value,unit)=>{
  if(value===null||value===undefined||value==='')return{};
  const text=String(unit||'千克').trim().toLowerCase();
  const factor={克:1,g:1,千克:1000,公斤:1000,kg:1000,斤:500,jin:500,两:50,毫克:0.001,mg:0.001,吨:1000000,t:1000000}[text];
  if(factor===undefined||!Number.isFinite(Number(value))||Number(value)<0)throw Object.assign(new Error('旧包装重量或重量单位无法换算，禁止猜测'),{name:'LegacyDataError'});
  return{weightG:Math.round(Number(value)*factor*1e6)/1e6,weightUnit:['千克','公斤','kg'].includes(text)?'kg':['斤','jin'].includes(text)?'jin':'g'};
};
// The old table is keyed by the source coding dictionary, not the archive tree.
exports.sourceNamingRuleValues = value => {
  const r=json(value);
  if(!Array.isArray(r.codeFields)||!r.codeFields.length||!Array.isArray(r.nameFields)||!r.nameFields.length)
    throw Error('原命名规则缺少字段顺序');
  const overrides=(values={})=>Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n');
  return {
    prefix:r.prefix??'ZH-',namePrefix:r.namePrefix??'组合-',stylePrefix:r.stylePrefix?(r.prefix??'ZH-'):'',
    codeFields:r.codeFields.join(','),nameFields:r.nameFields.join(','),customCode:r.customCode??'',customName:r.customName??'',
    codeOverrides:overrides(r.codeOverrides),nameOverrides:overrides(r.nameOverrides),
  };
};
exports.sourceNamingRules = tables => {
  const categories=new Map((tables.finance_product_code_dictionary||[]).filter(d=>d.dictionary_type==='product_category').map(d=>[String(d.id),d]));
  const records=[],exclusions=[],seen=new Set();
  for(const row of tables.finance_bundle_naming_rules||[]){
    const id=String(row.category_id),key='code:'+id;
    if(seen.has(id))throw Error('原来源分类命名规则重复');seen.add(id);
    const category=categories.get(id);
    if(category?.status!=='active'){
      exclusions.push({type:'finance-bundle-naming-rules',id:key,reason:'旧规则的来源编码分类不存在或已停用，保留来源记录'});
      continue;
    }
    records.push({type:'finance-bundle-naming-rules',id:key,status:'active',data:{
      codeDictionaryCategoryId:{legacyRef:{type:'finance-code-dictionaries',id}},...exports.sourceNamingRuleValues(row.rule_json),
    }});
  }
  return {records,exclusions};
};
exports.namingRules = (tables, categoryKey, categoryFamilies, preserveSourceScope = false) => {
  const dictionaries=tables.finance_product_code_dictionary||[], rules=tables.finance_bundle_naming_rules||[];
  const records=[],exclusions=[],used=new Set();
  for(const c of tables.finance_product_categories||[]){
    const p=json(c.payload_json);if(c.status==='deleted'||!p.productCodeCategoryId)continue;
    let id=String(p.productCodeCategoryId),selected;const seen=new Set();
    while(id&&!seen.has(id)){seen.add(id);selected=rules.find(r=>String(r.category_id)===id);if(selected)break;id=String(dictionaries.find(d=>String(d.id)===id)?.parent_id||'');}
    if(!selected)continue;used.add(String(selected.category_id));
    const r=json(selected.rule_json),leaf=dictionaries.find(d=>String(d.id)===String(p.productCodeCategoryId));
    const familyOf = c.archive_key==='purchased' ? (p.supplyModeScope==='supplier_oem'||p.productCodeCategoryScope==='supplier_oem'?'supplier_oem':'original_purchase') : c.archive_key;
    for(const family of categoryFamilies.get(String(c.id))||new Set([familyOf])){
      const names={...(r.nameOverrides||{})},codes={...(r.codeOverrides||{})};
      if(leaf&&r.nameFields.includes('category')&&!names.category)names.category=leaf.item_name;
      if(leaf&&r.codeFields.includes('category')&&!codes.category)codes.category=leaf.item_code;
      records.push({type:'finance-bundle-naming-rules',id:`${selected.category_id}:${categoryKey(c.id,family)}`,status:'active',data:{
        categoryId:{legacyRef:{type:'finance-categories',id:categoryKey(c.id,family)}},prefix:r.prefix,namePrefix:r.namePrefix??'组合-',stylePrefix:r.stylePrefix?r.prefix:'',
        codeFields:r.codeFields.join(','),nameFields:r.nameFields.join(','),customCode:r.customCode||'',customName:r.customName||'',
        codeOverrides:Object.entries(codes).map(([k,v])=>`${k}=${v}`).join('\n'),nameOverrides:Object.entries(names).map(([k,v])=>`${k}=${v}`).join('\n'),
      }});
    }
  }
  if(preserveSourceScope){const source=exports.sourceNamingRules(tables);records.push(...source.records);exclusions.push(...source.exclusions);}
  else for(const r of rules)if(!used.has(String(r.category_id)))exclusions.push({type:'finance-bundle-naming-rules',id:String(r.category_id),reason:'没有显式的档案分类→基础编码分类关联，未猜测适用范围'});
  return{records,exclusions};
};
/** OEM purchasePrice in the target is the seed-only input. Old purchasePrice
 * and production_bom are totals with different scopes, never interchangeable. */
exports.oemRawPurchase = payload => {
  const { yuanToPreciseCents, sumUnitCents } = require('@kudesi/shared');
  const raw = payload.rawMaterialPurchasePrice;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const cents = yuanToPreciseCents(raw);
  if (cents < 0) throw Error('旧OEM原料采购价不能为负数');
  if (payload.packagingCost != null && payload.purchasePrice != null) {
    const packaging = yuanToPreciseCents(payload.packagingCost);
    if (packaging < 0 || sumUnitCents([cents, packaging]) !== yuanToPreciseCents(payload.purchasePrice))
      throw Error('旧OEM原料价、包材价与总采购价不一致，禁止猜测');
  }
  return raw;
};
exports.purchaseInput=(row,payload,costs)=>{
  if(row.archive_key==='purchased'&&row.supply_mode==='supplier_oem')return exports.oemRawPurchase(payload);
  const c=costs.find(x=>x.cost_type==='purchase');
  return c?c.unit_cost:payload.purchasePrice;
};
