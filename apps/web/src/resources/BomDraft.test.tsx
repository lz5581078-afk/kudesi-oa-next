import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import { resourceApi } from './api';
import { BomDraft,bomDraftRowFromRecord,loadBomRows, bomCollection, validBomRows, type BomDraftRow } from './BomDraft';

const state=vi.hoisted(()=>({user:{id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[] as string[],deny:[] as string[]}},load:vi.fn(),pickers:vi.fn()}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({can:()=>true,user:state.user})}));
vi.mock('./FinanceCompositionPicker',async orig=>({...await orig<typeof import('./FinanceCompositionPicker')>(),loadFinanceCompositionCatalog:state.load,FinanceCompositionPicker:(props:{group:string;onChange:(id:number)=>void;categoriesEnabled?:boolean})=>{state.pickers(props);return <button type="button" aria-label={`选择${props.group}`} onClick={()=>props.onChange(props.group==='labor'?8:5)}>选择{props.group}</button>;}}));
beforeEach(()=>{state.user.companyId=1;state.load.mockReset();state.load.mockResolvedValue({items:[],categories:[]});state.pickers.mockClear();});
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), resourceApi: { create: vi.fn(), update: vi.fn(), remove: vi.fn(), get: vi.fn(), list: vi.fn().mockResolvedValue({ items: [], total: 0 }) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('表单里的生产组成（新增和编辑同一个组件）', () => {
  it('按本类有的组分块；能加行、去掉行', () => {
    let rows: BomDraftRow[] = [];
    const { rerender } = render(<BomDraft rows={rows} groups={['raw', 'labor']} onChange={(r) => { rows = r; }} />);
    expect(screen.getByRole('group', { name: '原料组成' })).toBeTruthy();
    expect(screen.getByRole('group', { name: '人工组成' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'OEM 包装' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加原料组成' }));
    expect(rows).toEqual([{ kind: 'component', group: 'raw', id: null, qty: '', loss: '', qualityKey:expect.stringMatching(/^[0-9a-f-]{36}$/i) }]);
    rerender(<BomDraft rows={rows} groups={['raw', 'labor']} onChange={(r) => { rows = r; }} />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加人工组成' }));
    expect(rows[1]).toMatchObject({ kind: 'labor', group: 'labor' });
    rerender(<BomDraft rows={rows} groups={['raw', 'labor']} onChange={(r) => { rows = r; }} />);
    fireEvent.click(screen.getAllByRole('button', { name: '去掉' })[0]);
    expect(rows).toHaveLength(1);
  });
  it('不完整组成不能靠过滤后提交；完整行保持引用二选一', () => {
    const rows: BomDraftRow[] = [{ kind: 'component', group: 'raw', id: 5, qty: 2, loss: 3 }, { kind: 'labor', group: 'labor', id: 8, qty: 1, loss: '' }, { kind: 'component', group: 'raw', id: null, qty: 1, loss: '' }];
    expect(validBomRows(rows)).toHaveLength(2);
    expect(() => bomCollection(rows, [])).toThrow(/选择档案.*大于 0/);
    const collection = bomCollection(rows.slice(0, 2), []);
    expect(collection.rows).toMatchObject([{ values: { componentId: 5, laborId: null } }, { values: { laborId: 8, componentId: null } }]);
    expect(resourceApi.create).not.toHaveBeenCalled();
  });
});

const dto=(id:number,data:Record<string,unknown>)=>({id,type:'finance-products',title:'合成档案'+id,data,status:'active',statusReason:null,refLabels:{categoryId:'合成目录',unitId:'元/件'},files:{},secretConfigured:{},createdAt:'',updatedAt:''});
describe('reference=true 真24生产组成',()=>{
 it('自产原料/双包装/人工分组、精确空态和无有效版本禁用',async()=>{
  render(<BomDraft reference rows={[]} onChange={vi.fn()}/>);
  expect(screen.getByRole('button',{name:'增加原料'})).toBeTruthy();expect(screen.getByRole('button',{name:'增加产品包装'})).toBeTruthy();expect(screen.getByRole('button',{name:'增加OEM包装'})).toBeTruthy();
  for(const text of ['原料组成','包装组成','产品包装','OEM包装','还没有添加原料；请先在原料档案里维护商品，再在这里选择。','还没有添加包装；请先在产品包装档案里维护商品，再在这里选择。','还没有添加OEM包装；请先在OEM包装档案里维护商品，再在这里选择。'])expect(screen.getByText(text)).toBeTruthy();
  await screen.findByText('当前没有已启用且在有效期内的人力成本版本');expect(screen.getByRole('button',{name:'增加人工'}).hasAttribute('disabled')).toBe(true);expect(screen.getByText('需要先启用有效的人力成本版本')).toBeTruthy();expect(screen.queryByRole('button',{name:/添加/})).toBeNull();
 });
 it('有效人工版本展示真实名；增加/选择沿同一row契约，选后才默认1，删除保留其他行',async()=>{
  state.load.mockResolvedValue({version:dto(9,{versionName:'合成当前版本',versionCode:'HC09'}),items:[dto(8,{unitPrice:100})],categories:[]});let rows:BomDraftRow[]=[];
  const renderDraft=()=> <BomDraft reference groups={['raw','labor']} rows={rows} onChange={next=>{rows=next;}}/>;const view=render(renderDraft());await screen.findByText('当前版本：合成当前版本');fireEvent.click(screen.getByRole('button',{name:'增加人工'}));expect(rows).toEqual([{kind:'labor',group:'labor',id:null,qty:'',loss:'',qualityKey:expect.stringMatching(/^[0-9a-f-]{36}$/i)}]);view.rerender(renderDraft());fireEvent.click(screen.getByRole('button',{name:'选择labor'}));expect(rows[0]).toMatchObject({id:8,qty:1});view.rerender(renderDraft());expect(bomCollection(rows,[]).rows[0].values).toMatchObject({laborId:8,componentId:null,qty:1});fireEvent.click(screen.getByRole('button',{name:'删除该人工成本'}));expect(rows).toEqual([]);expect(resourceApi.create).not.toHaveBeenCalled();
 });
 it('自产展示真实采购/运装/重量细分，不把totalCost当采购价，无额外损耗设置',()=>{
  const records=new Map([['component:5',dto(5,{purchasePrice:1000,freight:200,handlingFee:50,totalCost:999999,weightG:1000,purchaseSpec:'千克',specUnit:'KG'})]]);
  render(<BomDraft reference groups={['raw']} records={records} rows={[{kind:'component',group:'raw',id:5,qty:2,loss:''}]} onChange={vi.fn()}/>);
  expect(screen.getByText('¥10.000')).toBeTruthy();expect(screen.getByText('运费 / 装卸费')).toBeTruthy();expect(screen.getByText('¥2.000 / ¥0.500')).toBeTruthy();expect(screen.getByText('本项合计 ¥5.000')).toBeTruthy();expect(screen.getByText('¥25.000')).toBeTruthy();expect(screen.getByText('重量 2 kg')).toBeTruthy();expect(screen.queryByText('损耗设置')).toBeNull();
 });
 it('OEM独立紧凑包装行和实际小数用量合计，不出现自产分组或分类按钮',()=>{
  const records=new Map([['component:5',dto(5,{purchasePrice:8,totalCost:1000,weightG:20,purchaseSpec:'张',specUnit:'ZH'})]]);render(<BomDraft reference groups={['oem_package']} records={records} rows={[{kind:'component',group:'oem_package',id:5,qty:2.5,loss:''}]} onChange={vi.fn()}/>);
  for(const text of ['OEM包装档案','包装档案','个数/用量','系统规格','包装费用','包装费用合计'])expect(screen.getByText(text)).toBeTruthy();expect(screen.getAllByText('¥0.200')).toHaveLength(2);expect(screen.getByText('¥0.080 × 2.5')).toBeTruthy();expect(state.pickers.mock.calls.at(-1)?.[0]).toMatchObject({group:'oem_package',categoriesEnabled:false});expect(screen.queryByText('本项成本')).toBeNull();
 });
 it('未授权成本不显示金额和成本摘要，选择器也沿canCost=false',()=>{
  render(<BomDraft reference groups={['raw']} canCost={false} records={new Map([['component:5',dto(5,{purchasePrice:9999,weightG:1000})]])} rows={[{kind:'component',group:'raw',id:5,qty:1,loss:''}]} onChange={vi.fn()}/>);expect(screen.queryByText(/¥/)).toBeNull();expect(screen.queryByText('本项成本')).toBeNull();expect(state.pickers.mock.calls.at(-1)?.[0]).toMatchObject({canCost:false});
 });
 it('身份切换时不接受旧版本返回，不短暂启用旧人工入口',async()=>{
  let finish!:(value:unknown)=>void;state.load.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));const view=render(<BomDraft reference groups={['labor']} rows={[]} onChange={vi.fn()}/>);await waitFor(()=>expect(state.load).toHaveBeenCalledTimes(1));state.user.companyId=2;view.rerender(<BomDraft reference groups={['labor']} rows={[]} onChange={vi.fn()}/>);await screen.findByText('当前没有已启用且在有效期内的人力成本版本');await act(async()=>finish({version:dto(1,{versionName:'旧公司人工'}),items:[dto(8,{unitPrice:9999})],categories:[]}));expect(screen.queryByText('当前版本：旧公司人工')).toBeNull();expect(screen.getByRole('button',{name:'增加人工'}).hasAttribute('disabled')).toBe(true);
 });
});

it('reference组成六位倍数与canonical行同值，费用不按4位截断',()=>{const rows:BomDraftRow[]=[{kind:'component',group:'raw',id:5,qty:0.123456,loss:''}];render(<BomDraft reference groups={['raw']} records={new Map([['component:5',dto(5,{purchasePrice:1000,freight:200,handlingFee:50,totalCost:1250,weightG:1000})]])} rows={rows} onChange={vi.fn()}/>);expect(screen.getByText('¥1.5432')).toBeTruthy();expect(bomCollection(rows,[]).rows[0].values.qty).toBe(0.123456);});

it('reference只读复用原卡与真实人工版本，不挂载选择器/增删/数量onChange',async()=>{
 state.load.mockResolvedValue({version:dto(9,{versionName:'只读当前人工',versionCode:'READ09'}),items:[dto(8,{unitPrice:100})],categories:[]});const onChange=vi.fn(),rows:BomDraftRow[]=[{kind:'component',group:'raw',id:5,qty:2,loss:''},{kind:'labor',group:'labor',id:8,qty:1,loss:''}];render(<BomDraft reference readOnly rows={rows} onChange={onChange} records={new Map([['component:5',dto(5,{purchasePrice:1000,freight:200,handlingFee:50,weightG:1000})],['labor:8',dto(8,{workName:'只读装箱',workCode:'READ-LAB',unitPrice:100})]])}/>);await screen.findByText('当前版本：只读当前人工');expect(state.pickers).not.toHaveBeenCalled();expect(screen.queryByRole('button')).toBeNull();expect(screen.getByText('¥25.000')).toBeTruthy();expect(screen.getByText('READ09')).toBeTruthy();for(const input of screen.getAllByRole('spinbutton')){expect((input as HTMLInputElement).readOnly).toBe(true);fireEvent.change(input,{target:{value:'99'}});}expect(onChange).not.toHaveBeenCalled();expect(rows[0].qty).toBe(2);expect((screen.getByRole('textbox',{name:'人工成本项目'}) as HTMLInputElement).value).toContain('只读装箱');
});
it('reference只读缺失档案/金额/重量不伪造0，不挂载选择器；缺成本权限不显示金额',()=>{
 const onChange=vi.fn();const view=render(<BomDraft reference readOnly groups={['raw']} rows={[{kind:'component',group:'raw',id:99,qty:1,loss:''}]} onChange={onChange}/>);expect((screen.getByRole('textbox',{name:'组成档案'}) as HTMLInputElement).value).toBe('档案资料未读取 #99');expect(screen.getAllByText(/待补齐/).length).toBeGreaterThan(0);expect(screen.queryByText(/¥0/)).toBeNull();expect(screen.queryByText('0 kg')).toBeNull();expect(state.pickers).not.toHaveBeenCalled();view.rerender(<BomDraft reference readOnly canCost={false} groups={['raw']} rows={[{kind:'component',group:'raw',id:5,qty:1,loss:''}]} records={new Map([['component:5',dto(5,{purchasePrice:9999,freight:1,handlingFee:1,weightG:1000})]])} onChange={onChange}/>);expect(screen.queryByText(/¥/)).toBeNull();expect(onChange).not.toHaveBeenCalled();
});

it('原文件人工真实存量无laborId可完整读取/只改qty；复制命令不发价格也不造ID',()=>{const row={...dto(44,{importLineKind:'labor',importLaborName:'合成存量装袋',importLaborCost:120.25,qty:1.5}),type:'finance-product-boms',version:'old-bom-version'},model=bomDraftRowFromRecord(row);expect(model).toMatchObject({kind:'labor',group:'labor',id:null,rowId:44,version:'old-bom-version',importedLabor:{name:'合成存量装袋',unitCost:120.25,sourceRowId:44,version:'old-bom-version'}});const edit=bomCollection([{...model,qty:2.123456}],[model]);expect(edit.expected).toEqual([{id:44,version:'old-bom-version'}]);expect(edit.rows).toEqual([{id:44,values:{qty:2.123456}}]);const{rowId:_id,...copy}=model;expect(bomCollection([copy],[]).rows).toEqual([{values:{qty:1.5,__sourceImportedLaborCopy:{rowId:44,version:'old-bom-version'}}}]);render(<BomDraft reference readOnly groups={['labor']} rows={[model]} onChange={vi.fn()}/>);expect((screen.getByRole('textbox',{name:'人工成本项目'}) as HTMLInputElement).value).toBe('合成存量装袋');expect((screen.getByRole('textbox',{name:'人工成本项目'}) as HTMLInputElement).readOnly).toBe(true);expect(screen.getByText('¥1.2025')).toBeTruthy();expect(screen.getByText('¥1.80375')).toBeTruthy();expect(state.pickers).not.toHaveBeenCalled();});
it('严格载入真实第201条包括原文件人工；空续页拒绝且不猜未知组件类型',async()=>{const rows=Array.from({length:201},(_,index)=>({...dto(index+1,index===200?{importLineKind:'labor',importLaborName:'最后存量人工',importLaborCost:1,qty:1}:{componentId:5,qty:1}),type:'finance-product-boms',version:'v'+index}));vi.mocked(resourceApi.get).mockResolvedValue(dto(5,{archiveType:'raw'}));vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:rows.slice(((q?.page??1)-1)*200,(q?.page??1)*200),total:201,page:q?.page??1,pageSize:200}));expect((await loadBomRows(7)).at(-1)?.importedLabor?.name).toBe('最后存量人工');vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:q?.page===1?rows.slice(0,200):[],total:201,page:q?.page??1,pageSize:200}));await expect(loadBomRows(7)).rejects.toThrow(/不完整/);expect(()=>bomDraftRowFromRecord({...dto(1,{componentId:5,qty:1}),type:'finance-product-boms'},'unknown')).toThrow(/未读取完整/);});
it('原文件人工只读沿源提示且不造人力ID或挂选择器',()=>{const model=bomDraftRowFromRecord({...dto(44,{importLineKind:'labor',importLaborName:'存量装袋',importLaborCost:120.25,qty:1}),type:'finance-product-boms',version:'actual-version'});render(<BomDraft reference readOnly groups={['labor']} rows={[model]} onChange={vi.fn()}/>);expect(screen.getByText('从已启用的人力成本版本中搜索或按分类选择')).toBeTruthy();expect(state.pickers).not.toHaveBeenCalled();expect(model.id).toBeNull();});

it('原文件人工编辑可选真实有效人工，替换清旧descriptor并按旧expected删除新增',()=>{const model=bomDraftRowFromRecord({...dto(44,{importLineKind:'labor',importLaborName:'存量装袋',importLaborCost:120.25,qty:1.5}),type:'finance-product-boms',version:'actual-old-version'});let rows:BomDraftRow[]=[];render(<BomDraft reference groups={['labor']} rows={[model]} onChange={next=>{rows=next;}}/>);expect(state.pickers).toHaveBeenCalledWith(expect.objectContaining({group:'labor',value:null,labelNow:'存量装袋'}));fireEvent.click(screen.getByRole('button',{name:'选择labor'}));expect(rows[0]).toMatchObject({kind:'labor',group:'labor',id:8,qty:1.5});expect(rows[0].importedLabor).toBeUndefined();expect(rows[0].rowId).toBeUndefined();expect(rows[0].version).toBeUndefined();const collection=bomCollection(rows,[model]);expect(collection.expected).toEqual([{id:44,version:'actual-old-version'}]);expect(collection.rows).toEqual([{values:{laborId:8,componentId:null,qty:1.5,lossPercent:0}}]);expect(JSON.stringify(collection.rows)).not.toContain('importLaborCost');});
