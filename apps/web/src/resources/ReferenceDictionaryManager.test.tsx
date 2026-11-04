import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ReferenceDictionaryManager} from './ReferenceDictionaryManager';
import {resourceApi,type ResourceDto} from './api';
import {financeDictionaryApi} from './financeDictionaryApi';
vi.mock('./financeDictionaryApi',async original=>({...await original<typeof import('./financeDictionaryApi')>(),financeDictionaryApi:{context:vi.fn(),preview:vi.fn()}}));
let company=1;
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:company,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('./api',async original=>({...await original<typeof import('./api')>(),resourceApi:{list:vi.fn(),saveForm:vi.fn(),create:vi.fn(),update:vi.fn(),remove:vi.fn(),changeStatus:vi.fn()}}));
vi.mock('./unitOptions',()=>({useUnitOptions:()=>({}),loadUnitOptions:vi.fn()}));
const r=vi.mocked(resourceApi),row=(id:number,title:string):ResourceDto=>({type:'finance-brands',id,title,data:{name:title,code:'B'+id},status:'active',statusReason:null,files:{},refLabels:{},secretConfigured:{},createdAt:'',updatedAt:''});
const dictionary=vi.mocked(financeDictionaryApi),usage={known:true,referenceCount:0,knownReferenceCount:0,archiveReferences:0,baseReferences:0,bundleReferences:0,otherReferences:0,bomReferences:0,childCount:0,codeLocked:false,nameLocked:false};
beforeEach(()=>{company=1;dictionary.context.mockResolvedValue({kind:'brand',rows:[1,2,3].map(id=>({id,usage}))});dictionary.preview.mockResolvedValue({code:'XP',baseCode:'XP',conflict:false,errors:[],nameConflict:null,nameMaxLength:160,codeMaxLength:48,usage:null});});afterEach(()=>{cleanup();vi.resetAllMocks();});
it('维护窗读取真实第201项，空续页不能冒充完整',async()=>{const rows=Array.from({length:201},(_,index)=>row(index+1,'品牌'+(index+1)));r.list.mockImplementation(async(_type,p)=>({items:rows.slice(((p?.page||1)-1)*200,(p?.page||1)*200),total:201,page:p?.page||1,pageSize:200}));const view=render(<ReferenceDictionaryManager target="finance-brands" title="品牌维护" onClose={()=>{}}/>);await screen.findByText('品牌201');view.unmount();r.list.mockImplementation(async(_type,p)=>({items:p?.page===1?rows.slice(0,200):[],total:201,page:p?.page||1,pageSize:200}));render(<ReferenceDictionaryManager target="finance-brands" title="品牌维护" onClose={()=>{}}/>);await screen.findByRole('alert');expect(screen.queryByText('品牌1')).toBeNull();});
it('身份变化后旧读取和旧保存不能覆盖新列表或回调新身份',async()=>{let finish!:(row:ResourceDto)=>void;const pick=vi.fn();r.list.mockResolvedValue({items:[row(1,'原公司品牌')],total:1,page:1,pageSize:200});r.create.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));const view=render(<ReferenceDictionaryManager target="finance-brands" title="品牌维护" onClose={()=>{}} onPick={pick}/>);await screen.findByText('原公司品牌');fireEvent.change(screen.getByRole('textbox',{name:/品牌名称/}),{target:{value:'保存中的旧品牌'}});fireEvent.click(screen.getByRole('button',{name:'新增品牌'}));await waitFor(()=>expect(r.create).toHaveBeenCalled());company=2;r.list.mockResolvedValue({items:[row(2,'新公司品牌')],total:1,page:1,pageSize:200});view.rerender(<ReferenceDictionaryManager target="finance-brands" title="品牌维护" onClose={()=>{}} onPick={pick}/>);await screen.findByText('新公司品牌');finish(row(3,'旧保存'));await waitFor(()=>expect(screen.queryByText('原公司品牌')).toBeNull());expect(pick).not.toHaveBeenCalled();});
it('编码新建内层沿统一资源提供搜索、修改与新增并选中；普通维护呈现保持默认',async()=>{r.list.mockResolvedValue({items:[row(1,'原品牌'),row(2,'另一品牌')],total:2,page:1,pageSize:200});r.create.mockResolvedValue(row(3,'新品牌'));const pick=vi.fn();render(<ReferenceDictionaryManager presentation="base-code" target="finance-brands" title="品牌管理" onClose={()=>{}} onPick={pick}/>);await screen.findByText('原品牌');expect(screen.getByRole('dialog').parentElement?.className).toContain('base-code-dictionary-backdrop');fireEvent.change(screen.getByRole('searchbox'),{target:{value:'原品牌'}});expect(screen.queryByText('另一品牌')).toBeNull();expect(screen.getByRole('button',{name:'修改'})).toBeTruthy();expect(screen.getByRole('button',{name:'删除原品牌'})).toBeTruthy();fireEvent.change(screen.getByRole('textbox',{name:/名称/}),{target:{value:'新品牌'}});fireEvent.change(screen.getByRole('textbox',{name:'编码'}),{target:{value:'NEWB'}});await waitFor(()=>expect((screen.getByRole('button',{name:'新增并选中'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'新增并选中'}));await waitFor(()=>expect(r.create).toHaveBeenCalledWith('finance-brands',{name:'新品牌',code:'NEWB'}));expect(pick).toHaveBeenCalledWith(expect.objectContaining({id:3}),false);});

it('真实引用锁住旧编码；未知引用不会展示未引用或允许删除',async()=>{r.list.mockResolvedValue({items:[row(1,'已引用品牌'),row(2,'旧资料')],total:2,page:1,pageSize:200});dictionary.context.mockResolvedValue({kind:'brand',rows:[{id:1,usage:{...usage,referenceCount:2,knownReferenceCount:2,codeLocked:true}},{id:2,usage:{...usage,known:false,referenceCount:null,codeLocked:true}}]});render(<ReferenceDictionaryManager presentation="base-code" target="finance-brands" title="品牌管理" onClose={()=>{}}/>);await screen.findByText('业务引用 2 次');expect(screen.getByText('引用情况待核对')).toBeTruthy();expect(screen.queryByText('未引用，可删除')).toBeNull();fireEvent.click(screen.getAllByRole('button',{name:'修改'})[0]);expect((screen.getByLabelText('编码') as HTMLInputElement).disabled).toBe(true);expect((screen.getByLabelText('编码') as HTMLInputElement).value).toBe('B1');fireEvent.click(screen.getByRole('button',{name:'删除旧资料'}));expect((await screen.findByRole('alert')).textContent).toContain('引用情况尚待核对');});
it('旧码不在打开编辑时重算，迟到建议也不覆盖人工输入',async()=>{r.list.mockResolvedValue({items:[{...row(1,'张'),data:{name:'张',code:'SHEET'}}],total:1,page:1,pageSize:200});let resolve!:(value:Awaited<ReturnType<typeof financeDictionaryApi.preview>>)=>void;dictionary.preview.mockImplementation(()=>new Promise(done=>{resolve=done;}));render(<ReferenceDictionaryManager presentation="base-code" target="finance-brands" title="品牌管理" onClose={()=>{}}/>);fireEvent.click(await screen.findByRole('button',{name:'修改'}));await waitFor(()=>expect(dictionary.preview).toHaveBeenCalled());expect((screen.getByLabelText('编码') as HTMLInputElement).value).toBe('SHEET');fireEvent.change(screen.getByLabelText('编码'),{target:{value:'MANUAL'}});resolve({code:'Z',baseCode:'Z',conflict:false,errors:[],nameConflict:null,nameMaxLength:160,codeMaxLength:48,usage:null});await waitFor(()=>expect((screen.getByRole('button',{name:'保存修改'}) as HTMLButtonElement).disabled).toBe(false));expect((screen.getByLabelText('编码') as HTMLInputElement).value).toBe('MANUAL');});

it('档案品牌管理仅名称新增，显示真实引用并保持窗口',async()=>{
 r.list.mockResolvedValue({items:[row(1,'已引用品牌')],total:1,page:1,pageSize:200});
 dictionary.context.mockResolvedValue({kind:'brand',rows:[{id:1,usage:{...usage,referenceCount:2,archiveReferences:2,codeLocked:true}}]});
 r.create.mockResolvedValue({...row(3,'重庆'),data:{name:'重庆',code:'CQ'}});
 const pick=vi.fn();render(<ReferenceDictionaryManager presentation="product-brand" target="finance-brands" title="管理品牌" onClose={()=>{}} onPick={pick}/>);
 await screen.findByText('B1 · 已引用 2 次');expect(screen.queryByLabelText('编码')).toBeNull();expect(screen.queryByRole('button',{name:'编辑'})).toBeNull();
 fireEvent.change(screen.getByLabelText(/品牌名称/),{target:{value:'重庆'}});fireEvent.click(screen.getByRole('button',{name:'新增品牌'}));
 await waitFor(()=>expect(r.create).toHaveBeenCalledWith('finance-brands',{name:'重庆'}));await screen.findByText('品牌“重庆”已保存，所有财务页面都可选择。');
 expect(pick).not.toHaveBeenCalled();expect(dictionary.preview).not.toHaveBeenCalled();
});
it('档案品牌重名恢复停用原ID；删除沿原内层确认而不打开原生阻塞框',async()=>{
 const original={...row(1,'原品牌'),status:'inactive'};r.list.mockResolvedValue({items:[original],total:1,page:1,pageSize:200});
 r.changeStatus.mockImplementation(async()=>{const active={...original,status:'active'};r.list.mockResolvedValue({items:[active],total:1,page:1,pageSize:200});return active;});
 const confirm=vi.spyOn(window,'confirm');render(<ReferenceDictionaryManager presentation="product-brand" target="finance-brands" title="管理品牌" onClose={()=>{}}/>);
 await screen.findByText('暂无品牌，请在上方新增。');fireEvent.change(screen.getByLabelText(/品牌名称/),{target:{value:'原品牌'}});fireEvent.click(screen.getByRole('button',{name:'新增品牌'}));
 await waitFor(()=>expect(r.changeStatus).toHaveBeenCalledWith('finance-brands',1,'active'));expect(r.create).not.toHaveBeenCalled();
 fireEvent.click(await screen.findByRole('button',{name:'删除品牌原品牌'}));expect(screen.getByRole('dialog',{name:'请确认操作'})).toBeTruthy();expect(r.remove).not.toHaveBeenCalled();expect(confirm).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(r.remove).not.toHaveBeenCalled();confirm.mockRestore();
});
it('档案编码单位按实际kind建议，手填码不被迟到覆盖且只提供新增删除',async()=>{
 r.list.mockResolvedValue({items:[{...row(1,'卷'),type:'finance-product-units',data:{kind:'shipping_unit',name:'卷',code:'J'}}],total:1,page:1,pageSize:200});
 dictionary.context.mockResolvedValue({kind:'spec_unit',rows:[{id:1,usage}]});dictionary.preview.mockResolvedValue({code:'CQD',baseCode:'CQD',conflict:false,errors:[],nameConflict:null,nameMaxLength:80,codeMaxLength:32,usage:null});
 r.saveForm.mockResolvedValue({...row(3,'重庆袋'),type:'finance-product-units',data:{kind:'shipping_unit',name:'重庆袋',code:'MANUAL'}});
 const pick=vi.fn();render(<ReferenceDictionaryManager presentation="product-unit" target="finance-product-units" kind="shipping_unit" title="维护发货物料规格单位" onClose={()=>{}} onPick={pick}/>);
 await screen.findByText('卷');expect(dictionary.context).toHaveBeenCalledWith('spec_unit','shipping_unit');expect(screen.queryByRole('button',{name:'编辑'})).toBeNull();expect(screen.getByRole('button',{name:'删除单位卷'})).toBeTruthy();
 const name=screen.getByLabelText(/单位名称/) as HTMLInputElement,code=screen.getByLabelText('单位编码') as HTMLInputElement;expect(name.maxLength).toBe(80);expect(code.maxLength).toBe(32);
 fireEvent.change(name,{target:{value:'重庆袋'}});await waitFor(()=>expect(code.value).toBe('CQD'));expect(dictionary.preview).toHaveBeenCalledWith('spec_unit','重庆袋',undefined,undefined,'shipping_unit');
 fireEvent.change(code,{target:{value:'MANUAL'}});fireEvent.click(screen.getByRole('button',{name:'新增单位'}));await waitFor(()=>expect(r.saveForm).toHaveBeenCalledWith('finance-product-units',expect.objectContaining({values:{kind:'shipping_unit',name:'重庆袋',code:'MANUAL'},collections:[]})));expect(pick).not.toHaveBeenCalled();
});
it('源虚拟默认项仅明确新增或删除时经同一整组表单提交，失败重试保持同key',async()=>{
 r.list.mockResolvedValue({items:[],total:0,page:1,pageSize:200});dictionary.context.mockResolvedValue({kind:'spec_unit',rows:[],defaults:[{name:'包',code:'B'},{name:'斤',code:'J'}]});
 r.saveForm.mockRejectedValueOnce(new Error('合成失败')).mockResolvedValue({...row(3,'新单位'),data:{kind:'archive_unit',name:'新单位',code:'XP'}});
 render(<ReferenceDictionaryManager presentation="product-unit" target="finance-product-units" kind="archive_unit" title="维护名称单位" onClose={()=>{}}/>);
 await screen.findByRole('button',{name:'删除单位包'});expect(r.saveForm).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText(/单位名称/),{target:{value:'新单位'}});await waitFor(()=>expect((screen.getByRole('button',{name:'新增单位'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'新增单位'}));await screen.findByText('合成失败');
 fireEvent.click(screen.getByRole('button',{name:'新增单位'}));await waitFor(()=>expect(r.saveForm).toHaveBeenCalledTimes(2));
 expect(r.saveForm.mock.calls[0][1]).toEqual(r.saveForm.mock.calls[1][1]);expect(r.saveForm.mock.calls[0][1].values).toMatchObject({kind:'archive_unit',__sourceUnitDefaults:{version:1,kind:'archive_unit',action:'add'}});
});
it('默认单位删除需内层明确确认，提交真实保留项而不伪造默认ID',async()=>{
 r.list.mockResolvedValue({items:[],total:0,page:1,pageSize:200});dictionary.context.mockResolvedValue({kind:'spec_unit',rows:[],defaults:[{name:'包',code:'B'},{name:'斤',code:'J'}]});r.saveForm.mockResolvedValue({...row(4,'斤'),data:{kind:'archive_unit',name:'斤',code:'J'}});
 render(<ReferenceDictionaryManager presentation="product-unit" target="finance-product-units" kind="archive_unit" title="维护名称单位" onClose={()=>{}}/>);fireEvent.click(await screen.findByRole('button',{name:'删除单位包'}));expect(r.saveForm).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'确认'}));await waitFor(()=>expect(r.saveForm).toHaveBeenCalledWith('finance-product-units',expect.objectContaining({values:{kind:'archive_unit',name:'斤',code:'J',__sourceUnitDefaults:{version:1,kind:'archive_unit',action:'remove',code:'B'}},collections:[]})));expect(r.remove).not.toHaveBeenCalled();
});

it('原字典搜索支持名称拼音首字母，即使旧编码是人工修改值',async()=>{
 r.list.mockResolvedValue({items:[{...row(1,'华泰'),data:{name:'华泰',code:'MANUAL'}}],total:1,page:1,pageSize:200});
 render(<ReferenceDictionaryManager presentation="base-code" target="finance-brands" title="品牌管理" onClose={()=>{}}/>);
 await screen.findByText('华泰');fireEvent.change(screen.getByRole('searchbox',{name:'搜索维护资料'}),{target:{value:' ht '}});
 expect(screen.getByText('华泰')).toBeTruthy();fireEvent.change(screen.getByRole('searchbox',{name:'搜索维护资料'}),{target:{value:'zzz'}});expect(screen.queryByText('华泰')).toBeNull();
});

it.each(['archive_unit','packaging_unit','shipping_unit'])('商品%s单位窗保留触发点焦点、真占位文字和独立呈现，不改变实际pool请求',async kind=>{
 render(<><button autoFocus>原单位字段</button><ReferenceDictionaryManager presentation="product-unit" target="finance-product-units" kind={kind} title="维护商品单位" onClose={()=>{}}/></>);
 await screen.findByRole('dialog',{name:'维护商品单位'});
 const name=screen.getByPlaceholderText('例如：箱'),code=screen.getByPlaceholderText('例如：CTN');
 expect(name.tagName).toBe('INPUT');expect(code.tagName).toBe('INPUT');expect(document.activeElement).toBe(screen.getByRole('button',{name:'原单位字段'}));
 expect(name.closest('.product-archive-unit-backdrop')).toBeTruthy();expect(screen.getByRole('button',{name:'新增单位'})).toBeTruthy();expect(screen.queryByText('编码设置',{selector:'summary'})?.closest('details')?.open).toBe(true);
 await waitFor(()=>expect(dictionary.context).toHaveBeenCalledWith('spec_unit',kind));expect(r.create).not.toHaveBeenCalled();expect(r.saveForm).not.toHaveBeenCalled();
});
it('商品品牌管理保持专属窗及原触发焦点、真实名称占位和新增按钮',async()=>{
 render(<><button autoFocus>原品牌字段</button><ReferenceDictionaryManager presentation="product-brand" target="finance-brands" title="管理品牌" onClose={()=>{}}/></>);
 await screen.findByRole('dialog',{name:'管理品牌'});expect(document.activeElement).toBe(screen.getByRole('button',{name:'原品牌字段'}));expect(screen.getByPlaceholderText('例如：华泰先行').closest('.product-archive-brand-backdrop')).toBeTruthy();expect(screen.getByRole('button',{name:'新增品牌'})).toBeTruthy();expect(screen.queryByLabelText('单位编码')).toBeNull();expect(r.create).not.toHaveBeenCalled();
});
