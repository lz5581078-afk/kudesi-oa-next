import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {RevisionDialog} from './BundleDialogs';
import {BundleBomDialog} from './BundleBomDialog';
import {resourceApi,type ResourceDto} from '../../../resources/api';
import {jstApi} from './jstApi';
vi.mock('../../../resources/api',async original=>({...await original<typeof import('../../../resources/api')>(),resourceApi:{list:vi.fn(),get:vi.fn()}}));
vi.mock('./jstApi',async original=>({...await original<typeof import('./jstApi')>(),jstApi:{bundleRevise:vi.fn()}}));
vi.mock('../../../resources/RecordDetail',()=>({useResourceCan:()=>()=>true}));
vi.mock('../FinanceModal',()=>({FinanceModal:({title,children}:{title:string;children:React.ReactNode})=><div role="dialog"><h2>{title}</h2>{children}</div>}));
const dto=(id:number,type:string,data:Record<string,unknown>,title='合成资料'):ResourceDto=>({id,type,data,title,status:'pending',statusReason:null,refLabels:{},files:{},secretConfigured:{},createdAt:'2026-11-03T12:00:00Z',updatedAt:'',version:'hc'});
const bundle=dto(7,'finance-bundles',{code:'ZH-HC',name:'合成组合'});
afterEach(()=>{cleanup();vi.resetAllMocks();});
beforeEach(()=>{vi.mocked(jstApi.bundleRevise).mockResolvedValue({} as never);vi.mocked(resourceApi.get).mockImplementation(async(type,id)=>dto(id,type,{},type==='finance-products'?'真实直接档案':'真实基础编码'));});
it('第201项混合直接档案BOM全部读到并原样提交，人工/赠品/成本字段不丢',async()=>{
 const rows=Array.from({length:201},(_,i)=>dto(i+1000,'finance-bundle-lines',{bundleId:7,role:i===0?'main':i===100?'labor':'package',...(i===200?{productId:901}:i===100?{laborId:902}:{baseCodeId:i+1}),qty:i===200?2.5:1,includeInJst:i===0,sortOrder:i,costBucket:i===200?'package':undefined,note:i===200?'第201项真实档案':undefined},'组成'+i));
 vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>{const all=type==='finance-bundle-lines'?rows:[],page=q?.page??1;return{items:all.slice((page-1)*200,page*200),total:all.length,page,pageSize:200};});
 render(<RevisionDialog bundle={bundle} onClose={()=>{}} onDone={()=>{}}/>);
 await screen.findByDisplayValue('组成200');fireEvent.change(screen.getByLabelText('修订原因（必填）'),{target:{value:'合成对照修改'}});fireEvent.click(screen.getByRole('button',{name:'提交修订'}));
 await waitFor(()=>expect(jstApi.bundleRevise).toHaveBeenCalledOnce());const saved=vi.mocked(jstApi.bundleRevise).mock.calls[0][2];expect(saved).toHaveLength(201);expect(saved[200]).toMatchObject({productId:901,role:'package',qty:2.5,includeInJst:false,costBucket:'package',sortOrder:200,note:'第201项真实档案'});expect(saved[200]).not.toHaveProperty('baseCodeId');expect(saved[100]).toMatchObject({laborId:902,role:'labor'});expect(resourceApi.list).toHaveBeenCalledWith('finance-bundle-lines',expect.objectContaining({page:2,fieldValue:7}));
},15000);
it('缺失续页不开放部分BOM保存',async()=>{
 vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>({items:type==='finance-bundle-lines'&&q?.page===1?[dto(11,type,{bundleId:7,baseCodeId:9,role:'main',qty:1})]:[],total:type==='finance-bundle-lines'?2:0,page:q?.page??1,pageSize:200}));
 render(<RevisionDialog bundle={bundle} onClose={()=>{}} onDone={()=>{}}/>);await screen.findByText('组成读取不完整，请关闭后重试');fireEvent.change(screen.getByLabelText('修订原因（必填）'),{target:{value:'不能丢失后项'}});expect((screen.getByRole('button',{name:'提交修订'}) as HTMLButtonElement).disabled).toBe(true);expect(jstApi.bundleRevise).not.toHaveBeenCalled();
});
it('BOM当前与历史都解析真实productId，保留原参与聚水潭事实',async()=>{
 const history=dto(30,'finance-bundle-revisions',{payload:JSON.stringify([{productId:901,role:'package',qty:2,includeInJst:true}]),reason:'真实组成修订'});
 vi.mocked(resourceApi.list).mockImplementation(async(type)=>{const rows=type==='finance-bundle-lines'?[dto(11,type,{bundleId:7,productId:901,role:'package',qty:2,includeInJst:true})]:type==='finance-bundle-revisions'?[history]:[];return{items:rows,total:rows.length,page:1,pageSize:200};});
 render(<BundleBomDialog bundle={bundle} onClose={()=>{}} onRevise={()=>{}}/>);await screen.findByText('真实直接档案');fireEvent.click(screen.getByRole('button',{name:'查看组成'}));await screen.findByText('修订 #30 的组成');expect(screen.queryByText(/组成数据不完整/)).toBeNull();expect(screen.getByText('真实直接档案')).toBeTruthy();expect(screen.getByText('是')).toBeTruthy();expect(resourceApi.get).toHaveBeenCalledWith('finance-products',901);
});
