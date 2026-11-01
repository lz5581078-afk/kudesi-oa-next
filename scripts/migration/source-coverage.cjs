'use strict';
const identifier = name => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw Error('旧表标识不安全，无法完成全表核对');
  return '`' + name + '`';
};
/** Counts only, inside the adapter's read-only consistent transaction. Never
 * SELECT * from unscoped tables or materialize large audit/session payloads. */
async function readSourceCoverage(connection, columns, selected, workflow) {
  const [tables] = await connection.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
  const read = { ...selected, ...(workflow?.tables || {}) }, inventory = [];
  for (const { name } of tables) {
    const [[count]] = await connection.query(`SELECT CAST(COUNT(*) AS CHAR) n FROM ${identifier(name)}`);
    if (!/^\d+$/.test(String(count?.n))) throw Error('旧表行数无法核实');
    const fields = columns.filter(c => c.t === name).sort((a,b) => Number(a.ordinal)-Number(b.ordinal)).map(c => ({name:c.c,primary:c.pk==='PRI',ordinal:Number(c.ordinal),type:c.type??null,nullable:c.nullable??null}));
    if (!fields.length) throw Error('旧表字段清单不完整');
    inventory.push({ table:name, totalRows:String(count.n), fields, readInCompanyScope:Object.hasOwn(read,name), companyRowsRead:read[name]?.length ?? null });
  }
  return { version:1, scope:'whole-source-database counts; selected rows retain verified company ownership', tables:inventory };
}
function uncoveredSourceTables(inventory) {
  return inventory.tables.filter(t => t.totalRows !== '0' && !t.readInCompanyScope).map(t => ({
    type:'source-table.unmapped',id:t.table,
    reason:`旧库该表全库共${t.totalRows}行，尚未核实公司归属和新站字段/历史落点；未读取整行，不能以其他表迁入成功代替验收`,
  }));
}
module.exports = { readSourceCoverage, uncoveredSourceTables };
