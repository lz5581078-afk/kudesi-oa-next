import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReferenceProductCategoryPicker } from './ReferenceProductCategoryPicker';
import { clearRefCache, loadRefOptions } from './ResourceReferenceControls';
import { resourceApi, type ResourceDto } from './api';
const identity=vi.hoisted(()=>({companyId:1}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:identity.companyId,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('./RecordForm',()=>({clearRefCache:vi.fn()}));
vi.mock('./FinanceCategoryManager',()=>({FinanceCategoryManager:()=>null}));
vi.mock('./api',async orig=>({...await orig<typeof import('./api')>(),resourceApi:{list:vi.fn()}}));
const node=(id:number,name:string,archiveType:string,extra:Record<string,unknown>={}):ResourceDto=>({id,type:'finance-categories',title:name,status:'active',statusReason:null,data:{name,archiveType,...extra},refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''});
beforeEach(()=>{identity.companyId=1;});afterEach(()=>{cleanup();clearRefCache();vi.resetAllMocks();});
it('OEM接受自身树与真实共享采购树，拒绝无证据原装树/其他类型，RefOption保留共享marker',async()=>{
 const own=node(10,'OEM本类','supplier_oem'),root=node(1,'原采购共用根','original_purchase',{importArchiveType:'purchased'}),child=node(2,'原采购共用末级','original_purchase',{importArchiveType:'purchased',parentId:1}),plain=node(3,'仅原装采购','original_purchase'),wrong=node(4,'其他类型','package',{importArchiveType:'purchased'});
 vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>{const rows=q?.tab==='supplier_oem'?[own]:[root,child,plain,wrong];return{items:rows,total:rows.length,page:1,pageSize:200};});
 const change=vi.fn();render(<ReferenceProductCategoryPicker values={{archiveType:'purchased',supplyMode:'supplier_oem'}} onChange={change}/>);
 await screen.findByRole('option',{name:'原采购共用根 / 原采购共用末级'});expect(screen.getByRole('option',{name:'OEM本类'})).toBeTruthy();expect(screen.queryByRole('option',{name:'仅原装采购'})).toBeNull();expect(screen.queryByRole('option',{name:'其他类型'})).toBeNull();
 fireEvent.change(screen.getByRole('combobox',{name:'分类'}),{target:{value:'2'}});expect(change).toHaveBeenCalledWith(2);
 expect((await loadRefOptions('finance-categories')).find(row=>row.value===2)).toMatchObject({archiveType:'original_purchase',importArchiveType:'purchased',leaf:true});
});
it('切公司后迟到目录不覆盖当前公司，不显示上一公司节点',async()=>{
 let finish!:(value:{items:ResourceDto[];total:number;page:number;pageSize:number})=>void;
 const pending=new Promise<{items:ResourceDto[];total:number;page:number;pageSize:number}>(resolve=>{finish=resolve;});
 vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>identity.companyId===1?pending:{items:q?.tab==='supplier_oem'?[node(20,'当前公司OEM类','supplier_oem')]:[],total:q?.tab==='supplier_oem'?1:0,page:1,pageSize:200});
 const view=render(<ReferenceProductCategoryPicker values={{archiveType:'purchased',supplyMode:'supplier_oem'}} onChange={()=>{}}/>);await waitFor(()=>expect(resourceApi.list).toHaveBeenCalledTimes(1));
 identity.companyId=2;view.rerender(<ReferenceProductCategoryPicker values={{archiveType:'purchased',supplyMode:'supplier_oem'}} onChange={()=>{}}/>);
 await screen.findByRole('option',{name:'当前公司OEM类'});await act(async()=>finish({items:[node(99,'上一公司目录','supplier_oem')],total:1,page:1,pageSize:200}));
 expect(screen.queryByRole('option',{name:'上一公司目录'})).toBeNull();expect(screen.getByRole('option',{name:'当前公司OEM类'})).toBeTruthy();
});
it('目录中途空页不能把不完整父树当末级可选，错误可重试',async()=>{
 vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:q?.page===1?[node(1,'不完整目录','supplier_oem')]:[],total:2,page:q?.page??1,pageSize:200}));
 render(<ReferenceProductCategoryPicker values={{archiveType:'purchased',supplyMode:'supplier_oem'}} onChange={()=>{}}/>);
 await screen.findByRole('alert');expect(screen.queryByRole('option',{name:'不完整目录'})).toBeNull();
 vi.mocked(resourceApi.list).mockResolvedValue({items:[],total:0,page:1,pageSize:200});fireEvent.click(screen.getByRole('button',{name:'重试'}));await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
});
