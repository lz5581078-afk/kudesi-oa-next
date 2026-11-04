import readXlsxFile,{readSheetNames} from 'read-excel-file';
import writeXlsxFile from 'write-excel-file';
import JSZip from 'jszip';

export const PRODUCT_COST_SHEET='商品档案成本';
export const PRODUCT_COST_HEADERS=['档案编号','档案名称','档案类型','成本类型','单位成本','计价单位','生效开始','生效结束','来源类型','来源说明','计算方式','手工锁定','锁定原因','状态','备注'] as const;
export interface ProductCostTable {headers:string[];rows:string[][]}
export interface ProductCostIssue {sheet:string;row:number;field:string;message:string}
const schema='product-archive-cost-v2';
const sources='人工录入,采购单,财务单据,本季成本表,本季成本推导,档案成本修复,历史包装构成表,生产BOM自动计算,系统自动计算,Excel导入';
const string=(v:unknown)=>v==null?'':v instanceof Date?v.toISOString().slice(0,10):String(v).trim();
const blobBuffer=(blob:Blob)=>typeof blob.arrayBuffer==='function'?blob.arrayBuffer():new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=()=>reject(new Error('Excel文件无法读取'));reader.readAsArrayBuffer(blob);});

/** Read the named data sheet, not the first (instruction) sheet. Keep physical row numbers. */
export async function readProductCostWorkbook(file:File){
 const names=await readSheetNames(file);
 if(!names.includes(PRODUCT_COST_SHEET))throw new Error(`缺少“${PRODUCT_COST_SHEET}”工作表`);
 if(names.includes('填写说明')){const info=await readXlsxFile(file,{sheet:'填写说明'});const version=string(info[2]?.[1]);if(version&&version!==schema)throw new Error(`模板版本${version}不受支持`);}
 const table=await readXlsxFile(file,{sheet:PRODUCT_COST_SHEET}),headers=(table[0]??[]).map(string);
 const populated=headers.filter(Boolean);if(new Set(populated).size!==populated.length)throw new Error('商品档案成本第1行存在重复表头');
 const missing=PRODUCT_COST_HEADERS.filter(h=>!headers.includes(h));if(missing.length)throw new Error(`缺少列：${missing.join('、')}（请使用商品档案成本模板）`);
 const rows:Array<Record<string,string>>=[],rowNumbers:number[]=[];
 for(let index=1;index<table.length;index++){
  const cells=table[index].map(string);if(!cells.some(Boolean))continue;
  for(let c=0;c<cells.length;c++)if(cells[c]&&!headers[c])throw new Error(`商品档案成本第${index+1}行第${c+1}列缺少表头`);
  rows.push(Object.fromEntries(PRODUCT_COST_HEADERS.map(h=>[h,cells[headers.indexOf(h)]??''])));rowNumbers.push(index+1);
 }
 return {rows,rowNumbers};
}
export function productCostPhysicalIssues<T extends ProductCostIssue>(issues:T[],rowNumbers:readonly number[]):T[]{return issues.map(issue=>({...issue,row:issue.row>=2?rowNumbers[issue.row-2]??issue.row:issue.row}));}

/** The original two-sheet template; all codes and precise prices stay text. */
export async function buildProductCostWorkbook(table:ProductCostTable,companyName=''):Promise<Blob>{
 const missing=PRODUCT_COST_HEADERS.filter(h=>!table.headers.includes(h));if(missing.length)throw new Error(`成本模板缺少列：${missing.join('、')}`);
 const instructions=[['商品档案成本导入说明',''],['目标公司',companyName],['模板版本',schema],['数据归属','本文件写入商品档案的独立成本记录，不写入成本版本。'],['生效规则','同一档案可以保留多期成本；按业务日期取得有效记录。'],['导入规则','新增和更新，不删除文件中未出现的数据；任一错误都会阻断整份文件。'],['来源类型','仅允许模板下拉框中的固定中文选项。'],['参考列','档案名称和档案类型仅供审核，最终以系统档案为准。']];
 const header=PRODUCT_COST_HEADERS.map(value=>({type:String,value,fontWeight:'bold',color:'#FFFFFF',backgroundColor:'#1F7A4D',align:'center',alignVertical:'center',wrap:true,height:28}));
 const rows=table.rows.map(row=>PRODUCT_COST_HEADERS.map(h=>({type:String,value:row[table.headers.indexOf(h)]??'',backgroundColor:'#FFF2CC'})));
 const info=instructions.map((row,i)=>row.map((value,c)=>i===0&&c===1?null:({type:String,value,...(i===0?{fontSize:18,fontWeight:'bold',color:'#FFFFFF',backgroundColor:'#1F7A4D',...(c===0?{span:2}:{})}:c===0?{fontWeight:'bold',color:'#174C38'}:{wrap:true})})));
 const blob=await writeXlsxFile([info,[header,...rows]] as never,{sheets:['填写说明',PRODUCT_COST_SHEET],columns:[[{width:24},{width:96}],[25,30,18,18,15,15,16,16,18,38,38,14,35,14,35].map(width=>({width}))],showGridLines:false}) as unknown as Blob;
 const zip=await JSZip.loadAsync(await blobBuffer(blob));const sheet=zip.file('xl/worksheets/sheet2.xml');if(!sheet)throw new Error('成本模板生成失败');
 let xml=await sheet.async('string');
 xml=xml.replace(/(<sheetView\b[^>]*>)/,'$1<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
 xml=xml.replace('</worksheet>',`<autoFilter ref="A1:O1"/><dataValidations count="1"><dataValidation type="list" allowBlank="0" showErrorMessage="1" errorTitle="来源类型无效" error="请选择下拉列表中的来源类型" sqref="I2:I5001"><formula1>"${sources}"</formula1></dataValidation></dataValidations></worksheet>`);
 zip.file('xl/worksheets/sheet2.xml',xml);return new Blob([await zip.generateAsync({type:'arraybuffer'})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
export async function downloadProductCostWorkbook(table:ProductCostTable,filename='商品档案成本导入模板.xlsx',companyName='',shouldDownload:()=>boolean=()=>true){
 const blob=await buildProductCostWorkbook(table,companyName);if(!shouldDownload())return;const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();URL.revokeObjectURL(url);
}
