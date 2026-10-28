/** Excel / 飞书表格的剪贴板文本（TSV）：单元格里有换行、制表符或引号时用双引号包起来，引号写成两个。 */

export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  // 末尾换行不产生多余的空行
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[\t\n\r"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t')).join('\n');
}
