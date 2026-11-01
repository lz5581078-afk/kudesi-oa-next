'use strict';
const crypto = require('node:crypto');
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
/** Catalog only tables already read through the adapter's verified company
 * scope. Original rows stay intact, including deleted rows and old JSON data. */
function collectSourceRows(tables, columns, sourceCompanyId) {
  const out = [];
  for (const [table, rows] of Object.entries(tables)) {
    const primary = columns.filter(c => c.t === table && c.pk === 'PRI').sort((a, b) => Number(a.ordinal) - Number(b.ordinal)).map(c => c.c);
    const seen = new Set(), occurrences = new Map();
    for (const original of rows) {
      let key;
      if (original.id != null) key = String(original.id);
      else if (primary.length && primary.every(k => original[k] != null)) key = JSON.stringify(primary.map(k => original[k]));
      else {
        const digest = crypto.createHash('sha256').update(JSON.stringify(stable(original))).digest('hex');
        const n = (occurrences.get(digest) || 0) + 1; occurrences.set(digest, n);
        key = `sha256:${digest}:${n}`; // Preserve duplicate unkeyed rows as a bag.
      }
      if (seen.has(key)) throw Error('原始资料主键重复，不能合并保存'); seen.add(key);
      let row = original;
      if (original.company_id != null && String(original.company_id) !== String(sourceCompanyId)) {
        // The old position_duties.company_id is stale; the adapter's explicit
        // positions/departments join establishes ownership. Preserve both facts.
        if (table !== 'position_duties') throw Error('原始资料公司归属不一致');
        row = { company_id: sourceCompanyId, ownership: 'position.department', source_row: original };
      }
      out.push({ table, key, row });
    }
  }
  return out;
}
module.exports = { collectSourceRows };
