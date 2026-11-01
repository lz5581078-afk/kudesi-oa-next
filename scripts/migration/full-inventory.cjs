#!/usr/bin/env node
/** All-company, read-only inventory. Run inside the source host or target API container.
 * Outputs schema and aggregates, never record values, credential material or file contents.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
const legacy = args.includes('--legacy-app') ? option('--legacy-app') : null;
const output = args.includes('--output') ? option('--output') : '-';
const quote = value => {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('Unsafe schema identifier');
  return '`' + value + '`';
};
async function main() {
  if (!legacy && !args.includes('--runtime')) throw new Error('Choose --legacy-app <absolute directory> or --runtime');
  if (legacy && !path.isAbsolute(legacy)) throw new Error('Legacy directory must be absolute');
  const req = legacy ? createRequire(path.join(legacy, 'package.json')) : require;
  const env = legacy ? req('dotenv').parse(fs.readFileSync(path.join(legacy, '.env'))) : process.env;
  const connection = await req('mysql2/promise').createConnection({
    host: legacy ? env.MYSQL_HOST || '127.0.0.1' : env.DB_HOST,
    port: Number(legacy ? env.MYSQL_PORT || 3307 : env.DB_PORT || 3306),
    user: legacy ? env.MYSQL_USER : env.DB_USER,
    password: legacy ? env.MYSQL_PASSWORD : env.DB_PASSWORD,
    database: legacy ? env.MYSQL_DATABASE : env.DB_NAME,
    dateStrings: true,
  });
  const doc = { mode: 'all-company read-only inventory; no import or cleanup', startedAt: new Date().toISOString(), companies: [], tables: [], foreignKeys: [], resourceCounts: [], targetCatalog: [] };
  try {
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const [tables] = await connection.query("SELECT TABLE_NAME name, ENGINE engine, TABLE_ROWS estimatedRows, DATA_LENGTH dataBytes, INDEX_LENGTH indexBytes FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
    const [columns] = await connection.query('SELECT TABLE_NAME tableName,COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_KEY keyType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
    const [keys] = await connection.query('SELECT TABLE_NAME tableName,COLUMN_NAME columnName,REFERENCED_TABLE_NAME referencedTable,REFERENCED_COLUMN_NAME referencedColumn FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION');
    doc.foreignKeys = keys;
    const companyTable = tables.find(t => t.name === 'companies');
    if (companyTable) doc.companies = (await connection.query('SELECT id,name FROM companies ORDER BY id'))[0];
    for (const table of tables) {
      const fields = columns.filter(c => c.tableName === table.name).map(({ tableName, ...field }) => field);
      const [[row]] = await connection.query(`SELECT COUNT(*) n FROM ${quote(table.name)}`);
      const entry = { ...table, exactRows: String(row.n), columns: fields };
      if (fields.some(c => c.name === 'company_id')) {
        entry.byCompany = (await connection.query(`SELECT company_id companyId,COUNT(*) n FROM ${quote(table.name)} GROUP BY company_id ORDER BY company_id`))[0];
        if (companyTable) {
          const [[orphans]] = await connection.query(`SELECT COUNT(*) n FROM ${quote(table.name)} t LEFT JOIN companies c ON c.id=t.company_id WHERE t.company_id IS NOT NULL AND c.id IS NULL`);
          entry.missingCompanyRows = String(orphans.n);
        }
      }
      doc.tables.push(entry);
    }
    if (!legacy && tables.some(t => t.name === 'resource_records')) {
      doc.resourceCounts = (await connection.query('SELECT company_id companyId,type,status,COUNT(*) n FROM resource_records GROUP BY company_id,type,status ORDER BY company_id,type,status'))[0];
      try {
        const { RESOURCE_DEFS } = require('/app/packages/shared/dist/resources.js');
        doc.targetCatalog = RESOURCE_DEFS.map(d => ({ key:d.key,label:d.label,parent:d.parent,fields:d.fields.map(f=>({key:f.key,label:f.label,type:f.type,ref:f.ref,required:f.required,readonly:f.readonly,scale:f.scale,options:f.options})) }));
      } catch { doc.catalogUnavailable = true; }
    }
    await connection.rollback();
    doc.finishedAt = new Date().toISOString();
    doc.schemaFingerprint = crypto.createHash('sha256').update(JSON.stringify(doc.tables.map(t=>({name:t.name,columns:t.columns})))).digest('hex');
    const serialized = JSON.stringify(doc,null,2) + '\n';
    if (output === '-') process.stdout.write(serialized);
    else fs.writeFileSync(path.resolve(output),serialized,{mode:0o600,flag:'wx'});
  } finally { await connection.end(); }
}
main().catch(e => { console.error(JSON.stringify({phase:'inventory failed; no writes',code:e.code || e.name}));process.exitCode=1; });
