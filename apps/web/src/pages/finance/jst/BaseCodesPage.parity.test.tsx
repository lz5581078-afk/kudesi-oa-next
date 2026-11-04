import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BaseCodesPage } from './BaseCodesPage';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { jstApi } from './jstApi';
const identity=vi.hoisted(()=>({companyId:1}));
vi.mock('../../../auth/AuthContext',()=>({useAuth:()=>({can:()=>true,user:{id:1,companyId:identity.companyId,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('../../../resources/RecordDetail',()=>({RecordDetail:()=>null,useResourceCan:()=>()=>true}));
vi.mock('../../../resources/RecordForm',()=>({RecordForm:({initial}:{initial?:Record<string,unknown>})=><div role="dialog">{JSON.stringify(initial)}</div>}));
vi.mock('../../../resources/api',async orig=>({...await orig<typeof import('../../../resources/api')>(),resourceApi:{list:vi.fn(),export:vi.fn()}}));
vi.mock('./jstApi',async orig=>({...await orig<typeof import('./jstApi')>(),jstApi:{baseOverview:vi.fn()}}));
const dto=(id:number,title:string,data:Record<string,unknown>={}):ResourceDto=>({id,type:'finance-categories',title,status:'active',statusReason:null,data,refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''});
beforeEach(()=>{identity.companyId=1;vi.mocked(jstApi.baseOverview).mockResolvedValue({status:{pending:0,verified:0,reverify:0},byCategory:{}});});
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('完整201项目录/品牌含0记录末级，未选与父级不能新建，末级带入分类',async()=>{
 const categories=[dto(1,'合成父级',{kind:'product_category'}),...Array.from({length:199},(_,i)=>dto(i+2,`合成目录${i}`,{kind:'product_category',parentId:1})),dto(201,'最后末级',{kind:'product_category',parentId:1})];
 const brands=Array.from({length:201},(_,i)=>dto(i+300,`合成品牌${i}`));
 vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>{const all=type==='finance-code-dictionaries'?categories:type==='finance-brands'?brands:[];const page=q?.page??1;return{items:all.slice((page-1)*200,page*200),total:all.length,page,pageSize:200};});
 render(<BaseCodesPage/>);
 expect(screen.queryByRole('button',{name:'新建商品编码'})).toBeNull();
 await screen.findByRole('option',{name:'合成品牌200'});
 fireEvent.click(screen.getByRole('button',{name:'合成父级 0'}));
 expect(screen.queryByRole('button',{name:'新建商品编码'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'最后末级 0'}));
 fireEvent.click(screen.getByRole('button',{name:'新建商品编码'}));
 expect(screen.getByRole('dialog').textContent).toContain('"codeDictionaryCategoryId":201');
 expect(screen.getByRole('dialog').textContent).not.toContain('"categoryId"');
 expect(screen.getByRole('dialog').textContent).toContain('"origin":"composed"');
 expect(resourceApi.list).toHaveBeenCalledWith('finance-code-dictionaries',expect.objectContaining({page:2}));
 expect(resourceApi.list).toHaveBeenCalledWith('finance-brands',expect.objectContaining({page:2}));
});
it('原三页签顺序/键盘焦点，切换清分类品牌搜索勾选且已验证不能批选',async()=>{
 const record={...dto(9,'合成编码',{code:'HC-9',name:'合成商品',categoryId:5}),type:'finance-base-codes',status:'pending'};
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-code-dictionaries'?[dto(5,'合成末级',{kind:'product_category'})]:type==='finance-brands'?[dto(8,'合成品牌')]:[record],total:1,page:1,pageSize:200}));
 render(<BaseCodesPage/>);
 await screen.findByText('HC-9');
 const tabs=screen.getAllByRole('tab');expect(tabs.map(tab=>tab.textContent)).toEqual(['待验证0','已验证0','二次验证0']);
 fireEvent.change(screen.getByLabelText('搜索'),{target:{value:'合成搜索'}});fireEvent.change(screen.getByLabelText('品牌'),{target:{value:'8'}});fireEvent.click(screen.getByRole('button',{name:'合成末级 0'}));fireEvent.click(screen.getByLabelText('勾选 合成编码'));
 fireEvent.keyDown(tabs[0],{key:'ArrowRight'});
 expect(document.activeElement).toBe(tabs[1]);expect(tabs[1].getAttribute('aria-selected')).toBe('true');
 expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');expect((screen.getByLabelText('品牌') as HTMLSelectElement).value).toBe('');
 await waitFor(()=>expect(resourceApi.list).toHaveBeenLastCalledWith('finance-base-codes',expect.objectContaining({showHidden:true,keyword:undefined,fieldValue:undefined,filters:{realView:'foldVerified',verificationState:'verified'}})));
 expect((screen.getByLabelText('本页全选') as HTMLInputElement).disabled).toBe(true);
 fireEvent.keyDown(tabs[1],{key:'End'});expect(tabs[2].getAttribute('aria-selected')).toBe('true');
 fireEvent.keyDown(tabs[2],{key:'Home'});expect(tabs[0].getAttribute('aria-selected')).toBe('true');
});

it('关键词和品牌仅在查询或Enter应用，输入期间保留已完成结果',async()=>{
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-brands'?[dto(8,'合成品牌')]:[],total:type==='finance-brands'?1:0,page:1,pageSize:200}));
 render(<BaseCodesPage/>);
 await waitFor(()=>expect(jstApi.baseOverview).toHaveBeenCalledTimes(1));
 const before=vi.mocked(resourceApi.list).mock.calls.filter(([type])=>type==='finance-base-codes').length;
 fireEvent.change(screen.getByLabelText('搜索'),{target:{value:'合成待查'}});fireEvent.change(screen.getByLabelText('品牌'),{target:{value:'8'}});
 await new Promise(resolve=>setTimeout(resolve,250));
 expect(vi.mocked(resourceApi.list).mock.calls.filter(([type])=>type==='finance-base-codes')).toHaveLength(before);
 fireEvent.keyDown(screen.getByLabelText('搜索'),{key:'Enter'});
 await waitFor(()=>expect(resourceApi.list).toHaveBeenLastCalledWith('finance-base-codes',expect.objectContaining({keyword:'合成待查',filters:{realView:'foldVerified',verificationState:'pending',brandId:'8'}})));
});

it('主表恢复商品名/简称/成本kg重量列，移除误加款式与验证状态列',async()=>{
 const record={...dto(9,'合成编码',{code:'HC-9',name:'合成商品',shortName:'合成简称',categoryId:5,weightG:500,cost:12.3456}),type:'finance-base-codes',status:'pending'};
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-base-codes'?[record]:[],total:type==='finance-base-codes'?1:0,page:1,pageSize:200}));
 render(<BaseCodesPage/>);await screen.findByText('HC-9');
 expect(screen.getAllByRole('columnheader').map(head=>head.textContent)).toEqual(['','商品编码','商品名称','商品简称','成本价（含运费、装卸费）','重量','分类','操作']);
 expect(screen.getByText('合成简称')).toBeTruthy();expect(screen.getByText('0.5 kg')).toBeTruthy();expect(screen.getByText('¥0.123456')).toBeTruthy();
 expect(screen.getByRole('button',{name:'验证'})).toBeTruthy();expect(screen.getByRole('button',{name:'删除'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'同步'})).toBeNull();
});
it('启停是查询筛选而非验证页签，选择停用仍保留待验证事实过滤',async()=>{
 vi.mocked(resourceApi.list).mockResolvedValue({items:[],total:0,page:1,pageSize:30});
 render(<BaseCodesPage/>);await waitFor(()=>expect(jstApi.baseOverview).toHaveBeenCalledOnce());
 expect(screen.getAllByRole('tab')).toHaveLength(3);
 fireEvent.change(screen.getByLabelText('基础编码状态'),{target:{value:'inactive'}});
 fireEvent.click(screen.getByRole('button',{name:'查询'}));
 await waitFor(()=>expect(resourceApi.list).toHaveBeenLastCalledWith('finance-base-codes',expect.objectContaining({showHidden:true,filters:{realView:'foldVerified',verificationState:'pending',enabledState:'inactive'}})));
 expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('true');
});
