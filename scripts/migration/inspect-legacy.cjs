#!/usr/bin/env node
/** Read-only, aggregate-only legacy inspection. No raw credentials or business field values are exported. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const [appDir, companyArg, rulesPath, output] = process.argv.slice(2);
if (!appDir || !/^\d+$/.test(companyArg || '') || Number(companyArg) < 1 || !rulesPath || !output) {
  throw new Error('Usage: node inspect-legacy.cjs <legacy-app-dir> <company-id> <mapping-rules.json> <private-output.json>');
}
const companyId = Number(companyArg);
const requireLegacy = createRequire(path.join(path.resolve(appDir), 'package.json'));
requireLegacy('dotenv').config({ path: path.join(appDir, '.env') });
const mysql = requireLegacy('mysql2/promise');
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
const qi = (name) => { if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('Unsafe schema identifier'); return '`' + name + '`'; };
let schema;
function scope(name, alias = 't') {
  const t = schema.find((x) => x.name === name);
  if (!t) return null;
  if (name === 'companies') return { sql: `${alias}.id=?`, params: [companyId], kind: 'company-primary-key' };
  if (t.columns.some((c) => c.name === 'company_id')) return { sql: `${alias}.company_id=?`, params: [companyId], kind: 'direct-company-id' };
  const employee = (col) => ({ sql: `EXISTS(SELECT 1 FROM employees own_e JOIN departments own_d ON own_d.id=own_e.department_id WHERE own_e.id=${alias}.${qi(col)} AND own_d.company_id=?)`, params: [companyId], kind: 'employee-department-company' });
  if (['employees', 'positions'].includes(name)) return { sql: `EXISTS(SELECT 1 FROM departments own_d WHERE own_d.id=${alias}.department_id AND own_d.company_id=?)`, params: [companyId], kind: 'department-company' };
  if (['employee_positions','employee_roles','employee_permission_overrides','employee_responsibility_groups','employee_workforce_profiles'].includes(name)) return employee('employee_id');
  if (['position_permissions','position_responsibilities'].includes(name)) return { sql: `EXISTS(SELECT 1 FROM positions own_p JOIN departments own_d ON own_d.id=own_p.department_id WHERE own_p.id=${alias}.position_id AND own_d.company_id=?)`, params: [companyId], kind: 'position-department-company' };
  if (name === 'role_permissions') return { sql: `EXISTS(SELECT 1 FROM roles own_r WHERE own_r.id=${alias}.role_id AND own_r.company_id=?)`, params: [companyId], kind: 'role-company' };
  if (name === 'responsibility_group_items') return { sql: `EXISTS(SELECT 1 FROM responsibility_groups own_g WHERE own_g.id=${alias}.group_id AND own_g.company_id=?)`, params: [companyId], kind: 'group-company' };
  if (['license_borrow_records','license_usage_records'].includes(name)) return { sql: `EXISTS(SELECT 1 FROM business_licenses own_l WHERE own_l.id=${alias}.license_id AND own_l.company_id=?)`, params: [companyId], kind: 'license-company' };
  return null;
}
function shape(value, key, out, state, depth = 0) {
  if (depth > 14 || ++state.nodes > 500000) { state.truncated = true; return; }
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const p = out[key] ||= { types: [], observations: 0, empty: 0 };
  if (!p.types.includes(type)) p.types.push(type);
  p.observations++;
  if (value === null || value === '' || (typeof value === 'string' && !value.trim())) p.empty++;
  if (typeof value === 'string') p.maxLength = Math.max(p.maxLength || 0, value.length);
  if (type === 'array') {
    p.elements = (p.elements || 0) + value.length;
    p.minLength = Math.min(p.minLength ?? value.length, value.length);
    p.maxLength = Math.max(p.maxLength ?? value.length, value.length);
    for (const item of value) shape(item, key + '[]', out, state, depth + 1);
  } else if (type === 'object') {
    for (const [child, item] of Object.entries(value)) shape(item, key + '.' + child, out, state, depth + 1);
  }
}
(async () => {
  const connection = await mysql.createConnection({ host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3307), user: process.env.MYSQL_USER || 'oa_user', password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE || 'ecommerce_oa', dateStrings: true });
  const doc = { collectedAt: new Date().toISOString(), sourceCompanyId: companyId, mode: 'read-only aggregate inspection', tables: [], profiles: {}, jsonProfiles: {}, references: [], media: [] };
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const [tables] = await connection.query('SELECT TABLE_NAME name,TABLE_ROWS estimatedRows,DATA_LENGTH dataBytes,INDEX_LENGTH indexBytes FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
    const [columns] = await connection.query('SELECT TABLE_NAME tableName,COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_KEY keyType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
    schema = tables.map((t) => ({ ...t, columns: columns.filter((c) => c.tableName === t.name).map(({ tableName, ...c }) => c) }));
    doc.tables = schema;
    const [[company]] = await connection.query('SELECT id,name FROM companies WHERE id=?', [companyId]);
    if (!company) throw new Error('Selected company does not exist');
    doc.sourceCompany = company;
    const org = ['companies','departments','positions','position_permissions','position_duties','position_responsibilities','employees','employee_positions','employee_roles','roles','role_permissions','employee_permission_overrides','employee_workforce_profiles','employee_compensation_records','employee_workforce_attachments'];
    const selected = new Set([...Object.values(rules.resources).flatMap((r) => r.tables), ...org, 'resource_media', 'finance_product_archive_photos','finance_product_freight_history','finance_zero_value_reasons','finance_product_archive_types','finance_product_units','finance_product_packaging_units','finance_shipping_material_units','finance_production_cost_rates']);
    for (const name of selected) {
      const t = schema.find((x) => x.name === name), own = scope(name);
      if (!t) { doc.profiles[name] = { exists: false }; continue; }
      if (!own) { doc.profiles[name] = { exists: true, scoped: false, reason: 'No verified company ownership path; do not import' }; continue; }
      const [[count]] = await connection.query(`SELECT COUNT(*) n FROM ${qi(name)} t WHERE ${own.sql}`, own.params);
      const profile = doc.profiles[name] = { exists: true, scoped: true, scope: own.kind, rows: Number(count.n), fields: {}, enums: {} };
      if (!profile.rows) continue;
      const excluded = Object.values(rules.resources).filter((r) => r.tables.includes(name)).every((r) => r.policy === 'exclude-derived');
      const inspectFields = org.includes(name) || !excluded;
      if (inspectFields) {
        const fields = t.columns.filter((c) => !/^(json|blob|binary|varbinary)/i.test(c.type));
        if (fields.length) {
          const expressions = fields.flatMap((f, i) => [`SUM(${qi(f.name)} IS NULL OR TRIM(CAST(${qi(f.name)} AS CHAR))='') m${i}`, `MAX(CHAR_LENGTH(CAST(${qi(f.name)} AS CHAR))) l${i}`]);
          const [[counts]] = await connection.query(`SELECT ${expressions.join(',')} FROM ${qi(name)} t WHERE ${own.sql}`, own.params);
          fields.forEach((f, i) => { profile.fields[f.name] = { missing: Number(counts['m'+i]), maxLength: Number(counts['l'+i] || 0), type: f.type }; });
        }
      }
      const enums = ['status','archive_key','supply_mode','license_category','tax_category','account_kind','account_scope','usage_type','platform','workspace_template_key','role_key','cost_type'];
      for (const field of enums.filter((f) => t.columns.some((c) => c.name === f))) {
        const [rows] = await connection.query(`SELECT ${qi(field)} value,COUNT(*) n FROM ${qi(name)} t WHERE ${own.sql} GROUP BY ${qi(field)} LIMIT 50`, own.params);
        profile.enums[field] = rows;
      }
      if (t.columns.some((c) => c.name === 'unit_cost' && /decimal|float|double/i.test(c.type))) {
        const [[r]] = await connection.query(`SELECT SUM(unit_cost*100<>ROUND(unit_cost*100)) fractionalCentRows FROM ${qi(name)} t WHERE ${own.sql}`, own.params);
        profile.unitCostFractionalCentRows = Number(r.fractionalCentRows || 0);
      }
    }
    const jsonFields = [['finance_shared_archives','data_json'],['finance_express_catalogs','carriers_json'],['finance_express_cost_estimates','rows_json'],['finance_products','payload_json'],['finance_bundle_naming_rules','rule_json'],['self_media_accounts','platform_properties']];
    for (const [table, column] of jsonFields) {
      const own = scope(table);
      const [rows] = await connection.query(`SELECT ${table==='finance_shared_archives'?'archive_type,':''}${qi(column)} value FROM ${qi(table)} t WHERE ${own.sql}`, own.params);
      for (const row of rows) {
        const key = table + (row.archive_type ? ':' + row.archive_type : '') + '.' + column;
        const p = doc.jsonProfiles[key] ||= { sqlRows: 0, paths: {}, invalidJson: 0, truncated: false };
        p.sqlRows++;
        try { const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value; const state={nodes:0,truncated:false};shape(value,'$',p.paths,state);p.truncated ||= state.truncated; }
        catch { p.invalidJson++; }
      }
    }
    const references = [
      ['stores','license_id','business_licenses'],['stores','owner_id','employees'],['stores','current_claimer_id','employees'],
      ['phone_numbers','store_id','stores'],['phone_numbers','partner_profile_id','partner_profiles'],['phone_numbers','parent_phone_id','phone_numbers'],
      ['bank_accounts','license_id','business_licenses'],['bank_accounts','store_id','stores'],['bank_accounts','keeper_employee_id','employees'],['bank_u_shields','bank_account_id','bank_accounts'],
      ['tax_profiles','license_id','business_licenses'],['partner_profiles','license_id','business_licenses'],['qualifications','license_id','business_licenses'],
      ['finance_products','category_id','finance_product_categories'],['finance_product_base_codes','source_product_id','finance_products'],['finance_product_base_codes','canonical_base_code_id','finance_product_base_codes'],
      ['finance_product_code_links','product_id','finance_products'],['finance_product_code_links','base_code_id','finance_product_base_codes'],
      ['finance_product_bundle_codes','bom_id','finance_product_bundle_boms'],['finance_product_bundle_codes','bundle_definition_id','finance_product_bundle_definitions'],
      ['finance_product_bundle_bom_lines','base_code_id','finance_product_base_codes'],['finance_product_bundle_bom_lines','product_archive_id','finance_products'],
      ['license_borrow_records','borrower_employee_id','employees'],['employees','manager_id','employees'],['positions','supervisor_position_id','positions']
    ];
    for (const [table, field, parent] of references) {
      const own=scope(table), target=scope(parent,'p');if(!own||!target)continue;
      const invalid=`${own.sql} AND t.${qi(field)} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${qi(parent)} p WHERE p.id=t.${qi(field)} AND ${target.sql})`;
      const params=[...own.params,...target.params];
      const [[r]]=await connection.query(`SELECT COUNT(*) n FROM ${qi(table)} t WHERE ${invalid}`,params);
      let ids=[];if(Number(r.n)){const [rows]=await connection.query(`SELECT t.id FROM ${qi(table)} t WHERE ${invalid} ORDER BY t.id LIMIT 30`,params);ids=rows.map(x=>x.id);}
      doc.references.push({table,field,parent,missingOrCrossCompany:Number(r.n),sourceIds:ids,idsTruncated:Number(r.n)>30});
    }
    const employee=scope('employees');
    const [[accounts]]=await connection.query(`SELECT COUNT(*) people,SUM(TRIM(COALESCE(login_account,''))<>'') loginAccounts,SUM(TRIM(COALESCE(login_account,''))<>'' AND CHAR_LENGTH(password_hash)=128 AND CHAR_LENGTH(password_salt)=32) compatibleLegacyRecords FROM employees t WHERE ${employee.sql}`,employee.params);
    doc.accounts=accounts;
    const [duplicates]=await connection.query(`SELECT COUNT(*) n FROM (SELECT LOWER(TRIM(login_account)) a FROM employees t WHERE ${employee.sql} AND TRIM(COALESCE(login_account,''))<>'' GROUP BY LOWER(TRIM(login_account)) HAVING COUNT(*)>1) d`,employee.params);doc.accounts.duplicateGroups=Number(duplicates[0].n);
    const [baseProblems]=await connection.query('SELECT b.id, b.source_product_id sourceId, COUNT(DISTINCT l.product_id) linkedProducts FROM finance_product_base_codes b LEFT JOIN finance_product_code_links l ON l.base_code_id=b.id AND l.company_id=? WHERE b.company_id=? GROUP BY b.id,b.source_product_id HAVING b.source_product_id IS NULL OR COUNT(DISTINCT l.product_id)>1',[companyId,companyId]);
    doc.baseCodeSourceProblems=baseProblems;
    const [media]=await connection.query('SELECT id,resource_type resourceType,resource_id resourceId,field_key fieldKey,storage_path storagePath,sha256 FROM resource_media WHERE company_id=?',[companyId]);
    for(const row of media){const candidates=[path.resolve(appDir,'..','uploads',row.storagePath),path.resolve(appDir,row.storagePath),path.resolve(appDir,'..',row.storagePath),path.resolve(row.storagePath)];const roots=[path.resolve(appDir,'..','uploads')+path.sep,path.resolve(appDir,'uploads')+path.sep];const file=candidates.find(f=>roots.some(r=>f.startsWith(r))&&fs.existsSync(f)&&fs.statSync(f).isFile());let match=null;if(file&&row.sha256){const hash=crypto.createHash('sha256');const buffer=fs.readFileSync(file);hash.update(buffer);match=hash.digest('hex')===row.sha256;}doc.media.push({id:row.id,resourceType:row.resourceType,resourceId:row.resourceId,fieldKey:row.fieldKey,exists:!!file,shaMatches:match});}
    // Count excluded datasets only through a verified ownership path; never export their rows.
    for (const t of schema) {
      if (doc.profiles[t.name]) continue;
      const own=scope(t.name);
      if(!own){doc.profiles[t.name]={exists:true,scoped:false,reason:'No verified ownership path; no rows read'};continue;}
      try{const [[r]]=await connection.query(`SELECT /*+ MAX_EXECUTION_TIME(1500) */ COUNT(*) n FROM ${qi(t.name)} t WHERE ${own.sql}`,own.params);doc.profiles[t.name]={exists:true,scoped:true,scope:own.kind,rows:Number(r.n),countOnly:true};}
      catch(e){doc.profiles[t.name]={exists:true,scoped:true,scope:own.kind,rows:null,countError:e.code||e.name};}
    }
    await connection.rollback();
    fs.writeFileSync(output,JSON.stringify(doc,null,2),{mode:0o600});
    console.log('Read-only aggregate assessment complete. No raw business values or credential records exported.');
  } finally { await connection.end(); }
})().catch((e) => { console.error('Assessment failed:',e.code || e.name); process.exitCode=1; });
