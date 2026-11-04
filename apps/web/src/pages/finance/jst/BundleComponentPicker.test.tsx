import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {BundleComponentPicker} from './BundleComponentPicker';
import {resourceApi,type ResourceDto} from '../../../resources/api';
const identity=vi.hoisted(()=>({companyId:1}));
vi.mock('../../../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:identity.companyId,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('../../../resources/api',()=>({resourceApi:{list:vi.fn()}}));
const dto=(type:string,id:number,title:string,data:Record<string,unknown>,status='active'):ResourceDto=>({id,type,title,data,status,statusReason:null,refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''});
const category=dto('finance-categories',10,'真实原料类',{archiveType:'raw'});
afterEach(()=>{cleanup();vi.resetAllMocks();identity.companyId=1;});
it('完整201项目录支持跨页搜索选择，停用子级使父级不能冒作末级',async()=>{
 const items=Array.from({length:201},(_,i)=>dto('finance-products',i+1000,'商品'+i,{archiveType:'raw',categoryId:10,code:'RAW-'+i,specUnit:'KG',weightG:1000}));
 const parent=dto('finance-categories',20,'含停用子类的父级',{archiveType:'raw'}),child=dto('finance-categories',21,'停用子类',{archiveType:'raw',parentId:20},'inactive');
 const bad=dto('finance-products',999,'不应选择的父级商品',{archiveType:'raw',categoryId:20,code:'BAD'});
 vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>{const all=type==='finance-products'?[...items,bad]:[category,parent,child],page=q?.page??1;return{items:all.slice((page-1)*200,page*200),total:all.length,page,pageSize:200};});
 const choose=vi.fn();render(<BundleComponentPicker kind="archive" onChoose={choose} onClose={()=>{}}/>);await screen.findByRole('button',{name:/商品0 RAW-0/});expect(screen.queryByText('不应选择的父级商品')).toBeNull();fireEvent.change(screen.getByLabelText('搜索分类中的商品或人工'),{target:{value:'商品200'}});fireEvent.click(screen.getByRole('button',{name:/商品200 RAW-200/}));fireEvent.click(screen.getByRole('button',{name:'确认选择'}));expect(choose).toHaveBeenCalledWith(expect.objectContaining({id:1200}));expect(resourceApi.list).toHaveBeenCalledWith('finance-products',expect.objectContaining({page:2}));
});
it('空续页拒绝部分目录且不能确认已选ID',async()=>{vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>({items:type==='finance-categories'?[category]:q?.page===1?[dto(type,11,'部分商品',{archiveType:'raw',categoryId:10})]:[],total:type==='finance-categories'?1:2,page:q?.page??1,pageSize:200}));render(<BundleComponentPicker kind="archive" value={11} onChoose={()=>{}} onClose={()=>{}}/>);await screen.findByRole('alert');expect(screen.queryByText('部分商品')).toBeNull();expect((screen.getByRole('button',{name:'确认选择'}) as HTMLButtonElement).disabled).toBe(true);});
it('重复组成显式禁选，切换公司旧目录迟到不会覆盖新资料',async()=>{
 let resolveOld!:(value:{items:ResourceDto[];total:number;page:number;pageSize:number})=>void;const old=new Promise<{items:ResourceDto[];total:number;page:number;pageSize:number}>(resolve=>{resolveOld=resolve;});
 vi.mocked(resourceApi.list).mockImplementation(async type=>type==='finance-categories'?{items:[category],total:1,page:1,pageSize:200}:identity.companyId===1?old:{items:[dto(type,12,'新公司商品',{archiveType:'raw',categoryId:10,code:'NEW'})],total:1,page:1,pageSize:200});
 const rendered=render(<BundleComponentPicker kind="archive" excludedIds={[12]} onChoose={()=>{}} onClose={()=>{}}/>);identity.companyId=2;rendered.rerender(<BundleComponentPicker kind="archive" excludedIds={[12]} onChoose={()=>{}} onClose={()=>{}}/>);await screen.findByText('新公司商品');resolveOld({items:[dto('finance-products',11,'旧公司迟到商品',{archiveType:'raw',categoryId:10})],total:1,page:1,pageSize:200});await waitFor(()=>expect(screen.queryByText('旧公司迟到商品')).toBeNull());expect((screen.getByRole('button',{name:/新公司商品 NEW/}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole('button',{name:'确认选择'}) as HTMLButtonElement).disabled).toBe(true);
});
it('按原业务分组且保留目录项目顺序，空规格回退真实计量单位，克转换为千克展示',async()=>{
 const raw=dto('finance-products',30,'先维护的原料',{archiveType:'raw',categoryId:10,purchaseSpec:'千克',weightG:1000});
 const oemCategory=dto('finance-categories',20,'包装类',{archiveType:'oem_package'}),oem=dto('finance-products',31,'后维护的包装',{archiveType:'oem_package',categoryId:20,purchaseSpec:'张',weightG:10});
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-products'?[raw,oem]:[oemCategory,category],total:2,page:1,pageSize:200}));
 render(<BundleComponentPicker kind="archive" onChoose={()=>{}} onClose={()=>{}}/>);await screen.findByText('先维护的原料');
 const catalog=screen.getByRole('dialog',{name:'选择商品档案'}),names=Array.from(catalog.querySelectorAll('.bundle-component-picker-list strong')).map(node=>node.textContent);expect(names).toEqual(['先维护的原料','后维护的包装']);
 expect(Array.from(catalog.querySelectorAll('.bundle-component-picker-body aside>ul>li .bundle-catalog-node>span')).filter(node=>['原料档案','OEM包装'].includes(node.textContent||'')).map(node=>node.textContent)).toEqual(['原料档案','OEM包装']);
 expect(screen.getByText('张',{selector:'b'})).toBeTruthy();expect(screen.getByText('单位：张 · 0.01 kg')).toBeTruthy();
});
it('人工按真实工作分类分组，规格显示所属版本，unitId读取计价单位而非归档目录',async()=>{
 const labor=dto('finance-labor-costs',80,'作业/实际装袋',{workName:'实际装袋',workCode:'L-80',versionId:40,archiveCategoryId:99,workTypeId:50,unitId:60});
 const records:Record<string,ResourceDto[]>={'finance-labor-costs':[labor],'finance-labor-work-types':[dto('finance-labor-work-types',50,'包装工作分类',{})],'finance-labor-versions':[dto('finance-labor-versions',40,'当前真实成本版本',{})],'finance-labor-units':[dto('finance-labor-units',60,'元/件',{})]};
 vi.mocked(resourceApi.list).mockImplementation(async type=>({items:records[type]||[],total:(records[type]||[]).length,page:1,pageSize:200}));const choose=vi.fn();render(<BundleComponentPicker kind="labor" onChoose={choose} onClose={()=>{}}/>);await screen.findByText('实际装袋');expect(screen.getByText('包装工作分类',{selector:'.bundle-catalog-node>span'})).toBeTruthy();expect(screen.getByText('当前真实成本版本',{selector:'b'})).toBeTruthy();expect(screen.getByText('单位：元/件')).toBeTruthy();fireEvent.change(screen.getByLabelText('搜索分类中的商品或人工'),{target:{value:'当前真实成本版本'}});expect(screen.getByText('实际装袋')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:/实际装袋 L-80/}));fireEvent.click(screen.getByRole('button',{name:'确认选择'}));expect(choose).toHaveBeenCalledWith(expect.objectContaining({id:80,data:expect.objectContaining({unitId:60,unitName:'元/件'})}));
});
