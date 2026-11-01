import type { Connection } from 'mysql2/promise';
const {connectSource}=require('../../../../scripts/migration/legacy-adapter.cjs');
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('来源连接在保留证据前不改写JSON数值（MySQL）',()=>{
  let c:Connection;
  beforeAll(async()=>{
    c=await connectSource(require('mysql2/promise'),{MYSQL_HOST:process.env.DB_HOST,MYSQL_PORT:process.env.DB_PORT,MYSQL_USER:process.env.DB_USER,MYSQL_PASSWORD:process.env.DB_PASSWORD,MYSQL_DATABASE:process.env.TEST_DB_NAME??process.env.DB_NAME});
    // This table exists only on this connection in the isolated test database.
    await c.query('CREATE TEMPORARY TABLE source_precision_probe (id BIGINT UNSIGNED PRIMARY KEY,body JSON,quote DECIMAL(18,6),day DATE)');
  });
  afterAll(async()=>{await c?.end();});
  it('JSON直接与服务端文本相同，大整数和六位单价不经JS数值舍入；NULL/空串仍不同',async()=>{
    const json='{"amount":123456789012.123456,"externalId":9007199254740993,"nothing":null,"empty":"","quoted":"0001.230000","nested":[0.000001,1e-8]}';
    // SQL DECIMAL inside JSON can retain precision that a JS Number cannot.
    // JSON text numeric literals may already become DOUBLE on insertion; the
    // migration must preserve what is actually stored, not invent lost digits.
    await c.query("INSERT INTO source_precision_probe VALUES (?,JSON_SET(CAST(? AS JSON),'$.amount',CAST(? AS DECIMAL(18,6))),?,?)",['9007199254740993',json,'123456789012.123456','0.000015','2026-10-31']);
    const [rows]=await c.query('SELECT *,CAST(body AS CHAR CHARACTER SET utf8mb4) serverText FROM source_precision_probe');
    const row=(rows as Array<Record<string,unknown>>)[0];
    expect(row.id).toBe('9007199254740993');expect(typeof row.body).toBe('string');expect(row.body).toBe(row.serverText);
    expect(row.body).toContain('123456789012.123456');expect(row.body).toContain('9007199254740993');expect(row.body).toContain('"nothing": null');expect(row.body).toContain('"empty": ""');expect(row.body).toContain('0001.230000');
    expect(row.quote).toBe('0.000015');expect(row.day).toBe('2026-10-31');
  });
  it('安全整数维持现有算法的输入类型；原JSON字符串/数组不会被解析成另一种类型',async()=>{
    await c.query('INSERT INTO source_precision_probe VALUES (?,?,?,?)',[2,'"123456789012.123456"',null,null]);
    const [rows]=await c.query('SELECT * FROM source_precision_probe WHERE id=2');const row=(rows as Array<Record<string,unknown>>)[0];
    expect(row.id).toBe(2);expect(row.body).toBe('"123456789012.123456"');expect(row.quote).toBeNull();expect(row.day).toBeNull();
    await c.query('INSERT INTO source_precision_probe VALUES (?,?,?,?)',[3,'[9007199254740993,null,""]',null,null]);
    const [arrayRows]=await c.query('SELECT body,CAST(body AS CHAR CHARACTER SET utf8mb4) serverText FROM source_precision_probe WHERE id=3');const array=(arrayRows as Array<Record<string,unknown>>)[0];
    expect(typeof array.body).toBe('string');expect(array.body).toBe(array.serverText);expect(array.body).toContain('9007199254740993');
  });
});
