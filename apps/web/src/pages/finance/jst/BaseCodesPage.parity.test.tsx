import { cleanup, fireEvent, render, screen, waitFor,within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BaseCodesPage } from './BaseCodesPage';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { jstApi } from './jstApi';
import {api} from '../../../api/client';
const identity=vi.hoisted(()=>({companyId:1}));
vi.mock('../../../auth/AuthContext',()=>({useAuth:()=>({can:()=>true,user:{id:1,companyId:identity.companyId,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('../../../resources/RecordDetail',()=>({RecordDetail:()=>null,useResourceCan:()=>()=>true}));
vi.mock('../../../api/client',async orig=>({...await orig<typeof import('../../../api/client')>(),api:vi.fn()}));
vi.mock('../../../resources/api',async orig=>({...await orig<typeof import('../../../resources/api')>(),resourceApi:{list:vi.fn(),export:vi.fn()}}));
vi.mock('./jstApi',async orig=>({...await orig<typeof import('./jstApi')>(),jstApi:{baseOverview:vi.fn()}}));
const dto=(id:number,title:string,data:Record<string,unknown>={}):ResourceDto=>({id,type:'finance-categories',title,status:'active',statusReason:null,data,refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''});
beforeEach(()=>{identity.companyId=1;vi.mocked(api).mockResolvedValue({generated:{code:'FL-XP-1KG',styleCode:'FL-XP',name:'末级-新品',shortName:'新品',spec:'1千克'},errors:[]});vi.mocked(jstApi.baseOverview).mockResolvedValue({status:{pending:0,verified:0,reverify:0},byCategory:{}});});
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
 const dialog=screen.getByRole('dialog',{name:'新建商品基础编码'});
 await waitFor(()=>expect((within(dialog).getByRole('combobox',{name:'2级分类'}) as HTMLInputElement).value).toBe('最后末级'));
 expect((within(dialog).getByRole('combobox',{name:'1级分类'}) as HTMLInputElement).value).toBe('合成父级');
 expect(within(dialog).getByRole('button',{name:/添加商品档案/})).toBeTruthy();
 expect(within(dialog).queryByLabelText('来源商品档案')).toBeNull();
 await waitFor(()=>expect(api).toHaveBeenCalledWith(expect.stringContaining('codeDictionaryCategoryId=201')));
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
 expect(screen.getAllByRole('columnheader').map(head=>head.textContent?.replace(/[↕▲▼]/g,''))).toEqual(['','商品编码','商品名称','商品简称','成本价（含运费、装卸费）','重量','分类','操作']);
 expect(screen.getByText('合成简称')).toBeTruthy();expect(screen.getByText('0.5 kg')).toBeTruthy();expect(screen.getByText('¥0.123456')).toBeTruthy();
 expect(screen.getByRole('button',{name:'验证'})).toBeTruthy();expect(screen.getByRole('button',{name:'删除'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'同步'})).toBeNull();
});
it('只读列按源formatter最多八位呈现既有JSON事实，不以显示改写镜像或放宽输入',async()=>{
 const record={...dto(9,'八位镜像',{origin:'archive_sync',code:'DIRECT-8',name:'八位镜像',cost:124.691356,weightG:1000}),type:'finance-base-codes',status:'pending'};vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-base-codes'?[record]:[],total:type==='finance-base-codes'?1:0,page:1,pageSize:30}));render(<BaseCodesPage/>);expect(await screen.findByText('¥1.24691356')).toBeTruthy();expect(screen.queryByText('¥1.246914')).toBeNull();
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
it('列头保留原↕/▲/▼三态与下一步提示，二次验证仅可信来源已删显示行删除',async()=>{
 const rows=[{...dto(21,'来源已删',{code:'DEL',name:'已删商品'}),type:'finance-base-codes',status:'reverify',sourceStatus:'deleted'},{...dto(22,'来源仍在',{code:'LIVE',name:'在用商品'}),type:'finance-base-codes',status:'reverify',sourceStatus:'active'},{...dto(23,'未知来源',{code:'UNKNOWN',name:'未知商品',sourceStatus:'deleted'}),type:'finance-base-codes',status:'reverify'}];
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-base-codes'?rows:[],total:type==='finance-base-codes'?3:0,page:1,pageSize:30}));render(<BaseCodesPage/>);await screen.findByText('DEL');fireEvent.click(screen.getByRole('tab',{name:/二次验证/}));await screen.findByText('DEL');expect(screen.getAllByRole('button',{name:'删除'})).toHaveLength(1);expect(within(screen.getByText('DEL').closest('tr')!).getByRole('button',{name:'删除'})).toBeTruthy();expect(screen.getByText('来源已删除')).toBeTruthy();
 const header=screen.getAllByRole('columnheader').find(th=>th.textContent?.startsWith('商品编码'))!,sort=within(header).getByRole('button');expect(sort.textContent).toBe('商品编码↕');fireEvent.click(sort);expect(sort.textContent).toBe('商品编码▲');expect(header.getAttribute('aria-sort')).toBe('ascending');fireEvent.click(sort);expect(sort.textContent).toBe('商品编码▼');fireEvent.click(sort);expect(sort.textContent).toBe('商品编码↕');
});
it('已验证100项分两批只读读取真实同步事实，不根据行jstStatus猜成功',async()=>{
 const rows=Array.from({length:100},(_,i)=>({...dto(i+1,'同步资料'+i,{code:'HC-'+i,name:'同步资料'+i,jstStatus:'synced'}),type:'finance-base-codes',status:'verified'}));
 vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>({items:type==='finance-base-codes'?rows.slice(0,q?.pageSize??30):[],total:type==='finance-base-codes'?100:0,page:1,pageSize:q?.pageSize??30}));
 vi.mocked(api).mockImplementation(async path=>{const params=new URL(String(path),'http://synthetic').searchParams,ids=(params.get('ids')||'').split(',').filter(Boolean).map(Number);return {rows:ids.map(id=>({id,state:id%2?'synced':'failed'}))} as never;});render(<BaseCodesPage/>);await screen.findByText('HC-0');fireEvent.change(screen.getByLabelText('每页条数'),{target:{value:'100'}});fireEvent.click(screen.getByRole('tab',{name:/已验证/}));
 const stats=await screen.findByRole('status',{name:'本页聚水潭同步统计'});await waitFor(()=>expect(stats.textContent).toContain('同步成功 50 条'));expect(stats.textContent).toContain('同步失败 50 条');
 const calls=vi.mocked(api).mock.calls.filter(([path])=>String(path).startsWith('/finance/jst-sync/items?'));expect(calls).toHaveLength(2);expect(calls.map(([path])=>new URL(String(path),'http://synthetic').searchParams.get('ids')!.split(',').length)).toEqual([50,50]);expect(calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);expect(within(screen.getByText('HC-1').closest('tr')!).getByRole('button',{name:'同步失败'})).toBeTruthy();expect((screen.getByLabelText('本页全选') as HTMLInputElement).disabled).toBe(true);
});
it('只读报表投影恢复真身关联和待补齐入口，不把未知或data伪值当事实',async()=>{
 const rows=[{...dto(31,'真实编码',{code:'REAL',name:'真实编码'}),type:'finance-base-codes',status:'pending',baseCodeFacts:{issueCount:2,canonicalId:31,canonicalState:'pending' as const,aliasCount:1}},{...dto(32,'马甲',{code:'ALIAS',name:'马甲',canonicalId:31}),type:'finance-base-codes',status:'pending',baseCodeFacts:{issueCount:1,canonicalId:31,canonicalState:'pending' as const,aliasCount:0}},{...dto(33,'旧未知',{code:'OLD',name:'旧未知',issueCount:99}),type:'finance-base-codes',status:'pending'}];
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-base-codes'?rows:[],total:type==='finance-base-codes'?3:0,page:1,pageSize:30}));render(<BaseCodesPage/>);await screen.findByText('REAL');expect(screen.getByText('真身 · 关联 1 个马甲')).toBeTruthy();expect(screen.getByRole('button',{name:'真身待验证 · 处理真身'})).toBeTruthy();expect(screen.getByRole('button',{name:'待补齐 2 项'})).toBeTruthy();expect(screen.getByRole('button',{name:'待补齐 1 项'})).toBeTruthy();expect(screen.queryByText('待补齐 99 项')).toBeNull();expect(screen.queryByText('马甲',{selector:'.pill'})).toBeNull();
});
