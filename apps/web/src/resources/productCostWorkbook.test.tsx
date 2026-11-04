import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import writeXlsxFile from 'write-excel-file/node';
import JSZip from 'jszip';
import {buildProductCostWorkbook,readProductCostWorkbook,PRODUCT_COST_HEADERS,PRODUCT_COST_SHEET,productCostPhysicalIssues} from './productCostWorkbook';
const fileOf=(bytes:Uint8Array)=>{const file=new File([new Uint8Array(bytes).buffer],'合成原成本模板.xlsx');Object.defineProperty(file,'arrayBuffer',{value:async()=>bytes.buffer});return file;};
const bufferOf=(blob:Blob)=>new Promise<ArrayBuffer>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result as ArrayBuffer);r.onerror=reject;r.readAsArrayBuffer(blob);});
it('原模板顺序说明在首、成本在第二：真实xlsx按名读15列，精确值/前导0/物理行号保留',async()=>{
 const source=['00001','合成原料','原料','采购成本',1.000001,'千克','2026-11-04','','人工录入','','','否','','启用','合成'];
 const buffer=await writeXlsxFile([[['商品档案成本导入说明'],['目标公司','合成公司'],['模板版本','product-archive-cost-v2']],[PRODUCT_COST_HEADERS,[],source]].map(rows=>rows.map(row=>row.map(value=>typeof value==='number'?{type:Number,value}:{type:String,value}))),{sheets:['填写说明',PRODUCT_COST_SHEET],buffer:true});
 const parsed=await readProductCostWorkbook(fileOf(new Uint8Array(buffer)));expect(parsed.rowNumbers).toEqual([3]);expect(parsed.rows[0]).toMatchObject({'档案编号':'00001','单位成本':'1.000001','备注':'合成'});expect(Object.keys(parsed.rows[0])).toHaveLength(15);
 expect(productCostPhysicalIssues([{sheet:PRODUCT_COST_SHEET,row:2,field:'单位成本',message:'错误'}],parsed.rowNumbers)[0].row).toBe(3);
});
it('下载生成可回读的原两sheet/说明版本/15列表/来源下拉，编码及金额文字不变',async()=>{
 const row=PRODUCT_COST_HEADERS.map(h=>({'档案编号':'00001','单位成本':'0.335001','档案名称':'合成'} as Record<string,string>)[h]??'');
 const blob=await buildProductCostWorkbook({headers:[...PRODUCT_COST_HEADERS],rows:[row]},'合成公司');const bytes=new Uint8Array(await bufferOf(blob));
 const zip=await JSZip.loadAsync(bytes),workbook=await zip.file('xl/workbook.xml')!.async('string'),sheet=await zip.file('xl/worksheets/sheet2.xml')!.async('string');
 expect(workbook.indexOf('填写说明')).toBeLessThan(workbook.indexOf(PRODUCT_COST_SHEET));expect(sheet).toContain('sqref="I2:I5001"');expect(sheet).toContain('档案成本修复');expect(sheet).toContain('autoFilter ref="A1:O1"');
 const parsed=await readProductCostWorkbook(fileOf(bytes));expect(parsed.rows[0]).toMatchObject({'档案编号':'00001','单位成本':'0.335001'});expect(parsed.rowNumbers).toEqual([2]);
});
it('错误sheet/版本/缺列/重复列不能进入预检',async()=>{
 const book=async(headers:readonly string[],sheet=PRODUCT_COST_SHEET,version='product-archive-cost-v2')=>{const bytes=await writeXlsxFile([[['说明'],[],['模板版本',version]],[headers]].map(rows=>rows.map(row=>row.map(value=>({type:String,value})))),{sheets:['填写说明',sheet],buffer:true});return fileOf(new Uint8Array(bytes));};
 await expect(readProductCostWorkbook(await book(PRODUCT_COST_HEADERS,'错误表'))).rejects.toThrow(/缺少.*工作表/);
 await expect(readProductCostWorkbook(await book(PRODUCT_COST_HEADERS,PRODUCT_COST_SHEET,'future'))).rejects.toThrow(/不受支持/);
 await expect(readProductCostWorkbook(await book(PRODUCT_COST_HEADERS.slice(0,-1)))).rejects.toThrow(/备注/);
 await expect(readProductCostWorkbook(await book([...PRODUCT_COST_HEADERS,'档案编号']))).rejects.toThrow(/重复表头/);
});

it.skipIf(!process.env.PRODUCT_COST_REFERENCE_FIXTURE)('实际24号原构建器生成的纯合成模板可按成本sheet回读',async()=>{
 const bytes=new Uint8Array(readFileSync(process.env.PRODUCT_COST_REFERENCE_FIXTURE!));const parsed=await readProductCostWorkbook(fileOf(bytes));expect(parsed.rowNumbers).toEqual([2]);expect(parsed.rows[0]).toMatchObject({'档案编号':'00001','档案名称':'合成原版成本','单位成本':'0.335001','成本类型':'purchase','来源类型':'人工录入'});
});
