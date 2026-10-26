import readXlsxFile from 'read-excel-file';
import writeXlsxFile from 'write-excel-file';

/** 读 Excel 第一个工作表：每个单元格转成文字，日期转成 YYYY-MM-DD，空行跳过。 */
export async function readXlsxRows(file: File): Promise<string[][]> {
  const rows = await readXlsxFile(file);
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).trim();
  };
  return rows.map((r) => r.map(cell)).filter((r) => r.some((c) => c !== ''));
}

/** 生成 Excel 文件并下载：第一行当表头加粗；全部按文字写入，避免编码被当成数字丢掉前导 0。 */
export async function downloadXlsx(filename: string, rows: string[][]): Promise<void> {
  const data = rows.map((r, i) => r.map((v) => ({ type: String, value: v, ...(i === 0 ? { fontWeight: 'bold' as const } : {}) })));
  const blob = (await writeXlsxFile(data as never, {})) as unknown as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const isXlsx = (file: File) => /\.xlsx$/i.test(file.name);
