import readXlsxFile,{readSheetNames} from 'read-excel-file';
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


/** 多表导入保留原工作表名和行位置，空行由服务端跳过，错误行号不因前端滤空而偏移。 */
export async function readXlsxWorkbook(file:File):Promise<Array<{name:string;headers:string[];rows:Array<Record<string,string>>}>>{
  const names=await readSheetNames(file),sheets=[];
  const cell=(value:unknown)=>value==null?'':value instanceof Date?value.toISOString().slice(0,10):String(value).trim();
  for(const name of names){
    if(name==='说明'){sheets.push({name,headers:[],rows:[]});continue;}
    const raw=await readXlsxFile(file,{sheet:name}),headers=(raw[0]??[]).map(cell);
    const nonempty=headers.filter(Boolean);
    if(new Set(nonempty).size!==nonempty.length)throw new Error(`工作表“${name}”存在重复表头`);
    const rows=raw.slice(1).map((values,index)=>{
      const row:Record<string,string>={};
      for(let column=0;column<Math.max(headers.length,values.length);column++){
        const value=cell(values[column]),header=headers[column];
        if(!header){if(value)throw new Error(`工作表“${name}”第${index+2}行第${column+1}列缺少表头`);continue;}
        row[header]=value;
      }
      return row;
    });
    sheets.push({name,headers:nonempty,rows});
  }
  return sheets;
}
/** 多表模板的编码统一写为文本，不丢前导零。 */
export async function downloadWorkbook(filename:string,sheets:ReadonlyArray<{name:string;rows:ReadonlyArray<readonly string[]>}>):Promise<void>{
  const data=sheets.map(sheet=>sheet.rows.map((row,index)=>row.map(value=>({type:String,value,...(index===0?{fontWeight:'bold' as const}:{})}))));
  const blob=await writeXlsxFile(data as never,{sheets:sheets.map(sheet=>sheet.name)}) as unknown as Blob;
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();URL.revokeObjectURL(url);
}
