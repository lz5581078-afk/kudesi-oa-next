import {useEffect,useRef,useState} from 'react';
import {api} from '../api/client';
import {useCostIdentityKey} from '../pages/finance/CostIdentityBoundary';
import {downloadProductCostWorkbook,productCostPhysicalIssues,readProductCostWorkbook,type ProductCostIssue,type ProductCostTable} from './productCostWorkbook';
export interface ProductCostResult{errors:ProductCostIssue[];warnings:ProductCostIssue[];created:number;updated:number;rowCount:number;confirm?:string|null}
export function useProductCostExcelActions({canImport,confirm,onDone,companyName=''}:{canImport:boolean;confirm:(message:string)=>Promise<boolean>;onDone:()=>void;companyName?:string}){
 const identity=useCostIdentityKey(),current=useRef(identity);current.current=identity;
 const alive=useRef(true),working=useRef(false),generation=useRef(0);const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 useEffect(()=>{generation.current++;working.current=false;setBusy(false);setError('');setNotice('');},[identity]);
 const operation=async(action:(valid:()=>boolean)=>Promise<void>)=>{if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');const scope=identity,ticket=++generation.current;const valid=()=>alive.current&&current.current===scope&&generation.current===ticket;try{await action(valid);}catch(e){if(valid())setError(e instanceof Error?e.message:'操作失败');}finally{if(valid()){working.current=false;setBusy(false);}}};
 const downloadTemplate=()=>operation(async valid=>{const table=await api<ProductCostTable>('/finance/product-costs/template');if(valid())await downloadProductCostWorkbook(table,'商品档案成本导入模板.xlsx',companyName,valid);});
 const pickFile=(file:File)=>operation(async valid=>{
  if(!canImport)throw new Error('没有导入商品档案成本的权限');
  const parsed=await readProductCostWorkbook(file);if(!valid())return;
  const result=await api<ProductCostResult>('/finance/product-costs/import/preflight',{method:'POST',body:{rows:parsed.rows}});if(!valid())return;
  if(result.errors.length||!result.confirm){const issues=productCostPhysicalIssues(result.errors,parsed.rowNumbers);throw new Error(`档案成本未导入：\n${issues.slice(0,8).map(e=>`${e.sheet||'商品档案成本'}第${e.row||'-'}行：${e.message}`).join('\n')||'预检未通过'}`);}
  const confirmed=await confirm(`预检通过：新增${result.created}条、更新${result.updated}条，提醒${result.warnings.length}项。是否导入商品档案成本？`);if(!valid()||!confirmed)return;
  const done=await api<ProductCostResult>('/finance/product-costs/import/execute',{method:'POST',body:{rows:parsed.rows,confirm:result.confirm}});if(!valid())return;
  setNotice(`商品档案成本导入完成：新增${done.created}条、更新${done.updated}条。`);onDone();
 });
 return {busy,error,notice,downloadTemplate,pickFile};
}
