/** 迁移适配器测试用：把内存表伪装成旧库，不连任何真实数据库 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RESOURCE_DEFS } from '@kudesi/shared';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapter = require('../../../../scripts/migration/legacy-adapter.cjs');

export type FakeTables = Record<string, Array<Record<string, unknown>>>;
export interface FakeOut { sourceRows?: Array<{table:string;key:string;row:Record<string,unknown>}>; records: Array<{ type: string; id: string; data: Record<string, unknown>; status: string; notices?: string[]; sourceLocationOmission?: { row: Record<string, unknown>; location: Record<string, unknown> } }>; exclusions: Array<{ type: string; id: string; reason: string }> }

export async function readFakeLegacy(tables: FakeTables, companyId = 7, options: { parseWeightScope?: (raw: string) => unknown; preserveLegacyStates?: boolean } = {}): Promise<FakeOut> {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-app-'));
  try {
    fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"fake-legacy"}');
    fs.writeFileSync(path.join(appDir, '.env'), 'SECRET_KEY=x\n');
    fs.mkdirSync(path.join(appDir, 'node_modules/dotenv'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'node_modules/dotenv/index.js'), 'exports.parse=()=>({});');
    fs.mkdirSync(path.join(appDir, 'node_modules/mysql2'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'node_modules/mysql2/promise.js'), `
const tables=${JSON.stringify(tables)};
exports.createConnection=async()=>({
  beginTransaction:async()=>{},rollback:async()=>{},end:async()=>{},
  query:async(sql,args=[])=>{
    if(/information_schema.TABLES/.test(sql))return [Object.keys(tables).sort().map(name=>({name}))];
    if(/information_schema/.test(sql))return [Object.entries(tables).flatMap(([t,rows])=>Object.keys(rows[0]||{company_id:1}).map((c,i)=>({t,c,ordinal:i+1,pk:c==='id'?'PRI':''})))];
    if(/SELECT CAST\\(COUNT/.test(sql)){const name=sql.split('FROM ')[1].replaceAll(String.fromCharCode(96),'');return [[{n:String((tables[name]||[]).length)}]];}
    const m=/FROM \\\`(\\w+)\\\` t/.exec(sql);
    if(m){let rows=tables[m[1]]||[];if(m[1]==='company_locations'&&sql.includes('t.company_id=?'))rows=rows.filter(r=>String(r.company_id)===String(args[0]));return [rows];}
    return [[]];
  }
});`);
    fs.mkdirSync(path.join(appDir, 'server/core'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'server/core/business-secrets.js'), 'exports.createBusinessSecretCodec=()=>({decrypt:(x)=>x});');
    process.env.LEGACY_APP_DIR = appDir;
    return await adapter.read({ sourceCompanyId: companyId, definitions: RESOURCE_DEFS, preserveLegacyStates: options.preserveLegacyStates, parseWeightScope: options.parseWeightScope ?? (() => null) });
  } finally {
    delete process.env.LEGACY_APP_DIR;
    fs.rmSync(appDir, { recursive: true, force: true });
  }
}
