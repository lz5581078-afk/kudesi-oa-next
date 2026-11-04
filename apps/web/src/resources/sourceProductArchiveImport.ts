import {sourceProductImportProfile,SOURCE_PRODUCT_IMPORT_HEADERS,SOURCE_PRODUCT_IMPORT_LABELS,type SourceProductFamily} from '@kudesi/shared';
import {loadResourceDirectory} from './resourceDirectory';
import {csvToObjects,downloadText,parseCsv,readCsvText,toCsv} from './csv';
import {readXlsxWorkbook} from './xlsx';
import type {ProfileWorkbookSheet,ResourceDto} from './api';
const leafPath=(rows:ResourceDto[],family:SourceProductFamily)=>{const scoped=rows.filter(row=>row.data.archiveType===family),byId=new Map(scoped.map(row=>[row.id,row])),leaf=scoped.find(row=>row.status==='active'&&!scoped.some(child=>Number(child.data.parentId)===row.id));if(!leaf)return '';const path:string[]=[],seen=new Set<number>();for(let current:ResourceDto|undefined=leaf;current&&!seen.has(current.id);current=byId.get(Number(current.data.parentId))){seen.add(current.id);path.unshift(current.title);}return path.join(' / ');};
/** 模板是实际旧格式；填写示例含业务占位文字，不能直接作为真实业务导入。 */
export async function productArchiveTemplateSheets(family:SourceProductFamily,example:boolean,isCurrent:()=>boolean=()=>true){
 const profile=sourceProductImportProfile(family);if(!example)return profile.sheets.map(sheet=>({name:sheet.name,rows:[[...sheet.headers]]}));
 const categories=await loadResourceDirectory('finance-categories',isCurrent,undefined,{includeInactive:true,preserveOrder:true});
 if(!isCurrent())return [];
 const path=leafPath(categories??[],family)||({raw:'种子类 / 小麦',self_made:'常规成品',original_purchase:'外购种子',supplier_oem:'外购种子',package:'包装袋',oem_package:'供应商包装袋',shipping_material:'物料分类'})[family];
 const pack=['package','oem_package'].includes(family),purchase=['original_purchase','supplier_oem'].includes(family);
 const values:Record<string,string>={'原料名称':'示例：优质小麦种子','发货物料名称':'示例：发货物料','包装名称':family==='package'?'示例：500克装产品包装袋':'示例：供应商500克籼稻包装袋','外购成品名称':'示例：青禾玉米种子成品','自产成品名称':'示例：经典籼稻种子成品','所属分类':path,'品牌':pack?'示例品牌（包装档案必填）':purchase?'示例品牌（外购成品必填）':'示例品牌','原料生产编码':'YL-001','物料生产编码':'YL-001','产区':'山东','供应商名称':'示例供应商','供应商简称编码':'GY','规格':'25','名称规格':pack?'1':family==='self_made'?'500':'1','名称单位':pack?'个':family==='self_made'?'克':'千克','规格单位':'千克','产品包装规格':'1','产品包装单位':'包','包装类别':'无版印刷胶版','尺寸':'16×24','尺寸单位':'毫米','容量明细':'100克；200克','包装印刷公司':'示例印刷公司','重量':'14','重量单位':'克','系统规格':pack?'个':'包','称重重量':family==='self_made'?'0.52':'1.03','采购价':purchase?'18.50':pack?'0.335':family==='self_made'?'':'5.80','供货方式':family==='supplier_oem'?'供应商OEM':'原装采购','订单库存':'0','实际库存':'0','状态':'正常'};
 if(family==='self_made'){
  const products=await loadResourceDirectory('finance-products',isCurrent,undefined,{preserveOrder:true}),first=(type:string)=>String(products?.find(row=>row.data.archiveType===type)?.data.code||`请填写已有${type==='raw'?'原料':type==='package'?'产品包装':'OEM包装'}编号`),owner='ZC-CGCP-SLPP-JDXD-500G-1B-D';values['自产成品编号']=owner;if(!isCurrent())return [];
  return profile.sheets.map((sheet,index)=>({name:sheet.name,rows:[[...sheet.headers],index===0?sheet.headers.map(header=>values[header]||''):index===4?[owner,'分装人工','0.3']:[owner,first(['raw','package','oem_package'][index-1]),index===1?'0.5':'1']]}));
 }
 return profile.sheets.map(sheet=>({name:sheet.name,rows:[[...sheet.headers],sheet.headers.map(header=>values[header]||'')]}));
}
export async function downloadProductArchiveTemplate(family:SourceProductFamily,example:boolean,isCurrent:()=>boolean=()=>true){
 const sheets=await productArchiveTemplateSheets(family,example,isCurrent);
 if(!isCurrent()||!sheets.length)return;
 if(family!=='self_made'){downloadText(`${SOURCE_PRODUCT_IMPORT_LABELS[family]}档案导入${example?'填写示例-请勿直接导入':'空白模板'}.csv`,toCsv(sheets[0].rows));return;}
 const {default:writeXlsxFile}=await import('write-excel-file');
 const data=sheets.map(sheet=>sheet.rows.map((row,index)=>row.map(value=>({type:String,value,...(index===0?{fontWeight:'bold',color:'#FFFFFF',backgroundColor:'#0B8F5A',align:'center',alignVertical:'center'}:{})}))));
 const blob=await writeXlsxFile(data as never,{sheets:sheets.map(sheet=>sheet.name),stickyRowsCount:1,columns:sheets.map(sheet=>sheet.rows[0].map(header=>({width:Math.max(14,Math.min(34,header.length*2+8))})))}) as unknown as Blob;
 if(!isCurrent())return;
 const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=example?'自产成品档案及生产成本导入示例-请勿直接导入.xlsx':'自产成品档案及生产成本导入模板.xlsx';anchor.click();URL.revokeObjectURL(url);
}
export async function readProductArchiveImport(family:SourceProductFamily,file:File):Promise<{profileId:string;sheets:ProfileWorkbookSheet[]}>{
 if(file.size>10*1024*1024)throw new Error('文件超过10 MB上限，请拆分后导入');
 const excel=/\.xlsx$/i.test(file.name);if(excel){if(family!=='self_made')throw new Error('请选择 CSV 文件');return{profileId:sourceProductImportProfile(family).id,sheets:await readXlsxWorkbook(file)};}
 if(!/\.csv$/i.test(file.name))throw new Error(family==='self_made'?'请选择 CSV 或 Excel（.xlsx）文件':'请选择 CSV 文件');
 const raw=parseCsv(await readCsvText(file));if(!raw.length)throw new Error('文件中没有可导入数据');const headers=raw[0].map(header=>header.trim());if(new Set(headers).size!==headers.length)throw new Error('CSV 表头重复，请按原模板重新填写');const unknown=headers.filter(header=>!SOURCE_PRODUCT_IMPORT_HEADERS[family].includes(header));if(unknown.length)throw new Error('不认识的列：'+unknown.join('、'));if(raw.slice(1).some(row=>row.length>headers.length))throw new Error('数据行含模板以外的列');
 return{profileId:sourceProductImportProfile(family,true).id,sheets:[{name:'商品档案',headers,rows:csvToObjects(raw)}]};
}
