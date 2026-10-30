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
exports.namingRules = (tables, categoryKey, categoryFamilies) => {
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
  for(const r of rules)if(!used.has(String(r.category_id)))exclusions.push({type:'finance-bundle-naming-rules',id:String(r.category_id),reason:'没有显式的档案分类→基础编码分类关联，未猜测适用范围'});
  return{records,exclusions};
};
/** An automatic BOM result must not be counted again as extra purchase input. */
exports.purchaseInput=(row,payload,costs)=>{
  const c=costs.find(x=>x.cost_type==='purchase');
  if(row.archive_key==='purchased'&&row.supply_mode==='supplier_oem'&&c?.source_type==='production_bom')return undefined;
  return c?c.unit_cost:payload.purchasePrice;
};

/** Only gifts already used by old bundles; derive missing aliases from their real name/brand. */
exports.giftAliases=(tables,initials)=>{
  const products=tables.finance_products||[],bases=tables.finance_product_base_codes||[],used=new Set((tables.finance_product_bundle_bom_lines||[]).filter(l=>l.role==='gift'&&l.component_type==='base_code').map(l=>String(l.base_code_id)));
  const names=new Set(),codes=new Set(),result=new Map();
  for(const p of products){const d=json(p.payload_json);if(d.giftShortName)names.add(String(d.giftShortName).replace(/\s/g,''));if(d.giftCodeShortName)codes.add(String(d.giftCodeShortName).toUpperCase());}
  const productIds=new Set(bases.filter(b=>used.has(String(b.id))).map(b=>String(b.source_product_id||bases.find(c=>String(c.id)===String(b.canonical_base_code_id))?.source_product_id||'')));
  for(const p of products.filter(p=>productIds.has(String(p.id)))){
    const d=json(p.payload_json);if(d.giftShortName&&d.giftCodeShortName)continue;
    const label=String(d.giftShortName||`${p.brand||''}${p.product_name||''}`).replace(/[+×*\s]/g,'').slice(0,40);
    const code=String(d.giftCodeShortName||initials(label)).slice(0,20).toUpperCase();
    if(!label||!code||(!d.giftShortName&&names.has(label))||(!d.giftCodeShortName&&codes.has(code)))continue;
    result.set(String(p.id),{giftShortName:label,giftCodeShortName:code});names.add(label);codes.add(code);
  }
  return result;
};
