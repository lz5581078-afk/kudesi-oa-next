#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const { readWorkflowSource } = require('./workflow-source.cjs');
const { planWorkflowContinuations } = require('./workflow-plan.cjs');

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--legacy-app', '--company', '--report', '--rehearsal']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key) || options[key] !== undefined) throw new Error('Invalid argument');
    if (key === '--rehearsal') options[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing argument'); options[key] = args[++i]; }
  }
  const app = options['--legacy-app'], company = Number(options['--company']), report = options['--report'];
  if (!app || !path.isAbsolute(app) || !report || !path.isAbsolute(report) || !Number.isSafeInteger(company) || company <= 0) throw new Error('Absolute paths and source company required');
  const req = createRequire(path.join(app, 'package.json'));
  const env = req('dotenv').parse(fs.readFileSync(path.join(app, '.env')));
  const config = { host: env.MYSQL_HOST || '127.0.0.1', port: Number(env.MYSQL_PORT || 3307), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true };
  if (options['--rehearsal']) {
    if (process.env.FULL_REMIGRATION_REHEARSAL !== 'yes' || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'ecommerce_oa' || !process.env.DB_PASSWORD) throw new Error('Invalid rehearsal boundary');
    Object.assign(config, { host: '127.0.0.1', port: 3306, user: 'root', password: process.env.DB_PASSWORD, database: 'ecommerce_oa' });
  }
  // Reserve without overwriting an earlier result. Never print connection errors,
  // raw rows, forms, amounts, employee names or legacy authentication material.
  const fd = fs.openSync(report, 'wx', 0o600);
  let c;
  try {
    c = await req('mysql2/promise').createConnection(config);
    await c.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.query('SET SESSION TRANSACTION READ ONLY');
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const [columns] = await c.query('SELECT TABLE_NAME t,COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
    const source = await readWorkflowSource(c, columns, company);
    const plan = planWorkflowContinuations(source, new Date().toISOString());
    await c.rollback();
    fs.writeFileSync(fd, JSON.stringify(plan, null, 2));
    console.log(JSON.stringify({ phase: 'read-only workflow structural preflight', companyId: company, counts: plan.counts, issues: plan.issues.length, runtimeCompatibilityVerified: false, productionDataChanged: false }));
  } finally { fs.closeSync(fd); if (c) await c.end(); }
}
main().catch(() => { console.error('Workflow preflight stopped; no writes to business data. Inspect private inputs and report reservation.'); process.exitCode = 1; });
