import { cleanup, fireEvent, render, screen, waitFor,within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
const mocks = vi.hoisted(() => ({ create:vi.fn(), saveForm:vi.fn(),getDraft:vi.fn(), saveDraft:vi.fn(), removeDraft:vi.fn(), api:vi.fn(),upload:vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({user:{permissions:{isCompanyAdmin:true,allow:[],deny:[]}}}) }));
vi.mock('../api/client', async orig => ({ ...await orig<typeof import('../api/client')>(), api: (...args:unknown[]) => mocks.api(...args) }));
vi.mock('./api', async orig => ({ ...await orig<typeof import('./api')>(), resourceApi:{...await orig<typeof import('./api')>().then(m => m.resourceApi),create:(...args:unknown[])=>mocks.create(...args),saveForm:(...args:unknown[])=>mocks.saveForm(...args),uploadFile:(...args:unknown[])=>mocks.upload(...args),fileUrl:vi.fn().mockResolvedValue({url:'data:image/png;base64,AA=='}),list:vi.fn().mockResolvedValue({items:[],total:0}),similarCheck:vi.fn().mockResolvedValue({warnings:[],blocked:[]})},draftApi:{key:()=> 'party-draft',get:()=>mocks.getDraft(),save:(...args:unknown[])=>mocks.saveDraft(...args),remove:()=>mocks.removeDraft()} }));
import { RecordForm } from './RecordForm';
import { copyInitialOf,copyValuesOf } from './HierRowActions';
import type { ResourceDto } from './api';
beforeEach(() => { vi.spyOn(window,'alert').mockImplementation(()=>{});mocks.create.mockResolvedValue({id:8,title:'新资料',data:{}});mocks.saveForm.mockResolvedValue({id:9,title:'停用费用',status:'inactive',data:{}});mocks.getDraft.mockResolvedValue({draft:null});mocks.saveDraft.mockResolvedValue({});mocks.removeDraft.mockResolvedValue({});mocks.api.mockImplementation(async (_path:string,body:{body:{values:Record<string,unknown>}}) => ({code:'GYS-AUTO',shortCode:body.body.values.shortName==='简称'?'JC':'X'})); });
afterEach(() => {cleanup();vi.clearAllMocks();vi.mocked(window.alert).mockRestore();});
const mount = (type='finance-suppliers') => render(<RecordForm def={getResourceDef(type)!} record={null} initial={{categoryIds:[3],categoryId:3}} onClose={()=>undefined} onSaved={()=>undefined} onContinued={()=>undefined}/>);

it('客户编辑停用在保存时问原因，携原版本整组保存且允许原非空单字原因',async()=>{
 const row={id:601,type:'finance-customers',title:'合成客户',status:'active',version:'customer-v1',data:{code:'KH-HC',name:'合成客户',categoryIds:[3],creditLimit:12300},refLabels:{categoryIds:'客户 / 合成类'},files:{},secretConfigured:{},createdAt:'2026-10-24T10:00:00Z',updatedAt:'2026-10-24T10:00:00Z',statusReason:null} as ResourceDto;
 const saved={...row,status:'inactive',version:'customer-v2'},onSaved=vi.fn();mocks.saveForm.mockResolvedValue(saved);
 render(<RecordForm def={getResourceDef('finance-customers')!} record={row} onClose={()=>{}} onSaved={onSaved}/>);
 expect(screen.getByLabelText('赊销额度')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('状态'),{target:{value:'inactive'}});
 expect(screen.queryByLabelText('停用原因')).toBeNull();
 fireEvent.click(within(document.querySelector('.rf-foot') as HTMLElement).getByRole('button',{name:'保存'}));
 const dialog=await screen.findByRole('dialog',{name:'填写停用原因'});
 expect(mocks.saveForm).not.toHaveBeenCalled();
 fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'停'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'确认提交'}));
 await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalledWith('finance-customers',expect.objectContaining({id:601,version:'customer-v1',values:expect.objectContaining({name:'合成客户',code:'KH-HC',categoryIds:[3],creditLimit:12300}),status:'inactive',statusReason:'停',collections:[]})));
 expect(onSaved).toHaveBeenCalledWith(saved);
});

it('客户复制及继续新增携真实来源版本，下一次保存更换幂等请求，不把旧父级当普通新选',async()=>{
 const row={id:601,type:'finance-customers',title:'源客户',status:'active',version:'source-v1',data:{name:'源客户',categoryIds:[3]},refLabels:{categoryIds:'旧父级'},files:{},secretConfigured:{},statusReason:null,createdAt:'2026-10-24T10:00:00Z',updatedAt:'2026-10-24T10:00:00Z'} as ResourceDto;
 const first={...row,id:602,version:'copy-v1',data:{...row.data,name:'副本客户'}},second={...first,id:603,version:'copy-v2'};
 mocks.saveForm.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
 render(<RecordForm def={getResourceDef(row.type)!} record={null} initial={copyInitialOf(getResourceDef(row.type)!,row)} onClose={()=>{}} onSaved={()=>{}} onContinued={()=>{}}/>);
 fireEvent.change(screen.getByLabelText(/客户名称/),{target:{value:'副本客户'}});
 fireEvent.click(screen.getByRole('button',{name:'不清除保存继续新增'}));
 await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalledTimes(1));
 expect(mocks.saveForm.mock.calls[0][1]).toMatchObject({copySource:{id:601,version:'source-v1',files:{}},values:{categoryIds:[3],name:'副本客户'}});
 await waitFor(()=>expect(window.alert).toHaveBeenCalled());
 fireEvent.change(screen.getByLabelText(/客户名称/),{target:{value:'再次副本'}});
 fireEvent.click(screen.getByRole('button',{name:'不清除保存继续新增'}));
 await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalledTimes(2));
 expect(mocks.saveForm.mock.calls[1][1]).toMatchObject({copySource:{id:602,version:'copy-v1',files:{}},values:{categoryIds:[3],name:'再次副本'}});
 expect(mocks.saveForm.mock.calls[1][1].requestKey).not.toBe(mocks.saveForm.mock.calls[0][1].requestKey);
});

it('费用编辑为原平铺字段，可独立修改必挂对象，停用先问原因并保留原版本',async()=>{
 const row={id:701,type:'finance-fee-items',title:'合成费用',status:'active',version:'fee-v1',data:{code:'FY-HC',name:'合成费用',categoryId:3,direction:'expense',defaultObject:'公司',requiredObject:'no'},refLabels:{categoryId:'办公'},files:{},secretConfigured:{},createdAt:'2026-10-24T10:00:00Z',updatedAt:'2026-10-24T10:00:00Z',statusReason:null} as ResourceDto;
 render(<RecordForm def={getResourceDef(row.type)!} record={row} onClose={()=>{}} onSaved={()=>{}}/>);
 expect(screen.queryByRole('heading',{name:'费用设置'})).toBeNull();
 expect(screen.getByLabelText('费用单必须挂归属对象').tagName).toBe('SELECT');
 fireEvent.change(screen.getByLabelText('费用单必须挂归属对象'),{target:{value:'yes'}});
 fireEvent.change(screen.getByLabelText('状态'),{target:{value:'inactive'}});
 expect(screen.queryByLabelText('停用原因')).toBeNull();
 fireEvent.click(within(document.querySelector('.rf-foot') as HTMLElement).getByRole('button',{name:'保存'}));
 const reason=await screen.findByRole('dialog',{name:'填写停用原因'});
 expect(mocks.saveForm).not.toHaveBeenCalled();
 fireEvent.change(within(reason).getByRole('textbox'),{target:{value:'停'}});
 fireEvent.click(within(reason).getByRole('button',{name:'确认提交'}));
 await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalledWith(row.type,expect.objectContaining({id:701,version:'fee-v1',status:'inactive',statusReason:'停',values:expect.objectContaining({requiredObject:'yes',defaultObject:'公司'})})));
});

it('供应商原位编辑保留旧编号与简称，取消编辑和关闭整窗是独立入口',()=>{
 const onCancel=vi.fn(),onDismiss=vi.fn();
 const row={id:501,type:'finance-suppliers',title:'合成供货商',status:'active',data:{name:'合成供货商',shortName:'原简称',code:'GYS-HC',categoryIds:[3]},refLabels:{categoryIds:'种子供应商 / 玉米'},files:{},secretConfigured:{},createdAt:'2026-10-24T10:00:00Z',updatedAt:'2026-10-24T10:00:00Z',statusReason:null} as ResourceDto;
 render(<RecordForm def={getResourceDef('finance-suppliers')!} record={row} onClose={onCancel} onDismiss={onDismiss} onSaved={()=>{}}/>);
 const footer=document.querySelector('.rf-foot') as HTMLElement;
 expect(within(footer).getAllByRole('button').map(el=>el.textContent)).toEqual(['保存','取消编辑','关闭']);
 fireEvent.change(screen.getByLabelText(/供应商名称/),{target:{value:'改名'}});
 expect((screen.getByLabelText('供应商简称') as HTMLInputElement).value).toBe('原简称');
 expect((screen.getByLabelText('供应商编号') as HTMLInputElement).value).toBe('GYS-HC');
 fireEvent.click(within(footer).getByRole('button',{name:'取消编辑'}));expect(onCancel).toHaveBeenCalledTimes(1);expect(onDismiss).not.toHaveBeenCalled();
 fireEvent.click(within(footer).getByRole('button',{name:'关闭'}));expect(onDismiss).toHaveBeenCalledTimes(1);
 expect(mocks.create).not.toHaveBeenCalled();expect(mocks.saveForm).not.toHaveBeenCalled();
});

it('供应商简称跟随名称直到人工修改，编号可预览和人工修正，继续新增保留分类并清空资料', async () => {
  mount();
  fireEvent.change(screen.getByLabelText(/供应商名称/),{target:{value:'甲种业'}});
  expect((screen.getByLabelText('供应商简称') as HTMLInputElement).value).toBe('甲种业');
  fireEvent.change(screen.getByLabelText('供应商简称'),{target:{value:'简称'}});
  fireEvent.change(screen.getByLabelText(/供应商名称/),{target:{value:'乙种业'}});
  expect((screen.getByLabelText('供应商简称') as HTMLInputElement).value).toBe('简称');
  await waitFor(()=>expect((screen.getByLabelText('供应商编号') as HTMLInputElement).value).toBe('GYS-AUTO'));
  expect((screen.getByLabelText('简称编号') as HTMLInputElement).value).toBe('JC');
  fireEvent.click(screen.getByRole('button',{name:'保存并继续新增'}));
  await waitFor(()=>expect(mocks.create).toHaveBeenCalled());
  expect(mocks.create).toHaveBeenCalledWith('finance-suppliers',expect.objectContaining({name:'乙种业',shortName:'简称',categoryIds:[3]}),'active');
  expect((screen.getByLabelText(/供应商名称/) as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('供应商简称') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText(/供应商名称/),{target:{value:'丙种业'}});
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  await waitFor(()=>expect(mocks.saveDraft).toHaveBeenCalledWith('party-draft',expect.objectContaining({payload:expect.objectContaining({categoryIds:[3],name:'丙种业'})})));
  expect(window.alert).toHaveBeenCalledWith('草稿已保存，再次点击新增时会自动恢复。');
});

it('费用保存并继续新增清空名称与备注，保留目录、挂账节点和费用口径', async () => {
  mount('finance-fee-items');
  fireEvent.blur(screen.getByLabelText(/费用类型名称/));expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'保存并继续新增'}));expect(window.alert).toHaveBeenCalledWith('请填写费用类型名称');expect(mocks.create).not.toHaveBeenCalled();
  expect((screen.getByLabelText('适用平台') as HTMLSelectElement).value).toBe('any');
  expect((screen.getByLabelText('是否走流程') as HTMLSelectElement).value).toBe('by_amount');
  expect(within(screen.getByLabelText('是否走流程')).getAllByRole('option').map(option=>option.textContent)).toEqual(['是','否','按金额判断']);
  expect(within(screen.getByLabelText('收支方向')).getAllByRole('option').map(option=>option.textContent)).toEqual(['支出','收入','冲减','往来']);
  await screen.findByRole('option',{name:'未分类'});
  expect(screen.queryByRole('heading',{name:'其他说明'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'店铺'}));
  fireEvent.click(screen.getByRole('button',{name:'手机号'}));
  fireEvent.change(screen.getByLabelText(/费用类型名称/),{target:{value:'测试费用'}});
  fireEvent.click(screen.getByRole('button',{name:'保存并继续新增'}));
  await waitFor(()=>expect(mocks.create).toHaveBeenCalled());
  expect((screen.getByLabelText(/费用类型名称/) as HTMLInputElement).value).toBe('');
  expect(mocks.create).toHaveBeenCalledWith('finance-fee-items',expect.objectContaining({categoryId:3,direction:'expense',defaultObject:'店铺、手机号'}),'active');
  expect(screen.getByRole('button',{name:'店铺'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'不固定'}));
  expect(screen.getByRole('button',{name:'店铺'}).getAttribute('aria-pressed')).toBe('false');
  expect(mocks.removeDraft).toHaveBeenCalled();
});

it('客户新增使用真实联系抽屉固定归属与分段，底部五按钮顺序不混入详情状态',async()=>{
 mount('finance-customers');
 expect(screen.getByRole('region',{name:'系统自动编号'})).toBeTruthy();expect(screen.getByRole('region',{name:'基础资料'})).toBeTruthy();expect(screen.getByRole('region',{name:'联系资料'})).toBeTruthy();
 expect(screen.queryByLabelText('客户分类')).toBeNull();expect(screen.queryByLabelText('状态')).toBeNull();
 const footer=document.querySelector('.rf-foot')!;
 expect(within(footer as HTMLElement).getAllByRole('button').map(button=>button.textContent)).toEqual(['不清除保存继续新增','保存并继续新增','保存草稿','保存','关闭']);
 expect(document.activeElement).toBe(screen.getByLabelText(/客户名称/));
 fireEvent.change(screen.getByLabelText('联系电话'),{target:{value:'138 0000 0001 / 400-123-4567 转9'}});fireEvent.change(screen.getByLabelText(/客户名称/),{target:{value:'自由联系电话客户'}});fireEvent.click(within(footer as HTMLElement).getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(mocks.create).toHaveBeenCalledWith('finance-customers',expect.objectContaining({phone:'138 0000 0001 / 400-123-4567 转9'}),'active'));
});
it('联系编号人工修正不添加恢复自动；费用使用修改/自动且无新增挂对象只读控件',async()=>{
 const view=mount();const code=document.querySelector('[data-field=code]')!;
 fireEvent.click(within(code as HTMLElement).getByRole('button',{name:'人工修正'}));expect(within(code as HTMLElement).getByRole('button',{name:'人工修正'})).toBeTruthy();expect(screen.queryByRole('button',{name:'恢复自动'})).toBeNull();
 view.unmount();mount('finance-fee-items');const feeCode=document.querySelector('[data-field=code]')!;
 fireEvent.click(within(feeCode as HTMLElement).getByRole('button',{name:'修改'}));expect(within(feeCode as HTMLElement).getByRole('button',{name:'自动'})).toBeTruthy();expect(screen.queryByText('费用单必须挂归属对象')).toBeNull();
 expect(within(document.querySelector('.rf-foot')as HTMLElement).getAllByRole('button').map(button=>button.textContent)).toEqual(['取消','保存草稿','保存并继续新增']);
});

it('费用草稿恢复停用状态，保存时独立弹理由并沿已有saveForm，草稿标记不进正式body',async()=>{
 mocks.getDraft.mockResolvedValue({draft:{payload:{name:'停用费用草稿',direction:'expense',categoryId:3,__draftStatus:'inactive',__archiveState:{manualCode:false}}}});
 const view=mount('finance-fee-items');await screen.findByDisplayValue('停用费用草稿');
 expect((screen.getByLabelText('状态')as HTMLSelectElement).value).toBe('inactive');expect(screen.queryByText(/已恢复/)).toBeNull();expect(screen.queryByRole('button',{name:'清除草稿'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(mocks.saveDraft).toHaveBeenCalledWith('party-draft',expect.objectContaining({payload:expect.objectContaining({__draftStatus:'inactive'})})));
 view.unmount();mount('finance-fee-items');await screen.findByDisplayValue('停用费用草稿');
 fireEvent.click(screen.getByRole('button',{name:'保存并继续新增'}));const dialog=await screen.findByRole('dialog',{name:'填写停用原因'});
 fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'合成停用原因'}});fireEvent.click(within(dialog).getByRole('button',{name:'确认提交'}));
 await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalledWith('finance-fee-items',expect.objectContaining({requestKey:expect.any(String),status:'inactive',statusReason:'合成停用原因',collections:[],values:expect.objectContaining({name:'停用费用草稿'})})));
 expect(mocks.saveForm.mock.calls[0][1].values).not.toHaveProperty('__draftStatus');expect(mocks.create).not.toHaveBeenCalled();
});

const copiedSupplier=():ResourceDto=>({id:41,type:'finance-suppliers',statusReason:null,createdAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z',version:'source-v1',title:'源供应商',status:'active',data:{name:'源供应商',categoryIds:[3],paymentQr:[71],bankAccountName:'原户名',bank:'原银行',bankAccountNo:'6222123456789000'},files:{71:{id:71,name:'原收款码.png',mime:'image/png',size:8}},refLabels:{},secretConfigured:{}});
it('供应商复制保留原可见银行账号和收款码预览，取消零写入，其他sensitive/files默认不复制',async()=>{
 const def=getResourceDef('finance-suppliers')!,row=copiedSupplier(),close=vi.fn();
 const initial=copyInitialOf(def,row);expect(initial.bankAccountNo).toBe('6222123456789000');
 expect(copyValuesOf({...def,fields:def.fields.map(field=>({...field,copyOnCreate:undefined}))},row.data)).not.toHaveProperty('bankAccountNo');
 render(<RecordForm def={def} record={null} initial={initial} onClose={close} onSaved={()=>undefined} onContinued={()=>undefined}/>);
 expect(screen.getByText('原收款码.png')).toBeTruthy();expect((screen.getByLabelText('银行账号')as HTMLInputElement).value).toBe('6222123456789000');
 expect(mocks.saveForm).not.toHaveBeenCalled();fireEvent.click(within(document.querySelector('.rf-foot')as HTMLElement).getByRole('button',{name:'关闭'}));expect(close).toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();expect(mocks.saveForm).not.toHaveBeenCalled();
});
it('复制最终saveForm才发送真实source版本/文件IDs，连续保留新增以上次新绑定为源，空白继续只继承分类不继承附件',async()=>{
 const def=getResourceDef('finance-suppliers')!,row=copiedSupplier();
 mocks.saveForm.mockResolvedValue({...row,id:42,version:'copy-v2',title:'新副本',data:{...row.data,paymentQr:[72]},files:{72:{id:72,name:'副本收款码.png',mime:'image/png',size:8}}});
 render(<RecordForm def={def} record={null} initial={copyInitialOf(def,row)} onClose={()=>undefined} onSaved={()=>undefined} onContinued={()=>undefined}/>);
 fireEvent.click(screen.getByRole('button',{name:'不清除保存继续新增'}));await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalled());
 await waitFor(()=>expect(window.alert).toHaveBeenCalledWith('保存成功，当前内容已保留，可以继续新增。'));expect(screen.queryByText(/可以继续新增/)).toBeNull();
 expect(mocks.saveForm).toHaveBeenLastCalledWith('finance-suppliers',expect.objectContaining({copySource:{id:41,version:'source-v1',files:{paymentQr:[71]}},values:expect.objectContaining({paymentQr:[],bankAccountNo:'6222123456789000'})}));
 fireEvent.click(screen.getByRole('button',{name:'保存并继续新增'}));await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalledTimes(2));
 expect(mocks.saveForm.mock.calls[1][1].copySource).toEqual({id:42,version:'copy-v2',files:{paymentQr:[72]}});
 await waitFor(()=>expect((screen.getByLabelText(/供应商名称/)as HTMLInputElement).value).toBe(''));
 fireEvent.change(screen.getByLabelText(/供应商名称/),{target:{value:'后续普通新增'}});fireEvent.click(within(document.querySelector('.rf-foot')as HTMLElement).getByRole('button',{name:'保存'}));await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalledTimes(3));
 expect(mocks.saveForm.mock.calls[2][1]).toMatchObject({copySource:{id:42,version:'copy-v2',files:{}},values:{paymentQr:[]}});
 expect(mocks.create).not.toHaveBeenCalled();
});
it('复制预览可删除或换图，保存只绑定新上传不再克隆原图',async()=>{
 const def=getResourceDef('finance-suppliers')!,row=copiedSupplier();mocks.upload.mockResolvedValue({id:99,name:'替换图.png',mime:'image/png',size:8});
 render(<RecordForm def={def} record={null} initial={copyInitialOf(def,row)} onClose={()=>undefined} onSaved={()=>undefined} onContinued={()=>undefined}/>);
 fireEvent.change(screen.getByLabelText('上传收款码'),{target:{files:[new File(['png'],'替换图.png',{type:'image/png'})]}});await screen.findByText('替换图.png');
 fireEvent.click(within(document.querySelector('.rf-foot')as HTMLElement).getByRole('button',{name:'保存'}));await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalled());expect(mocks.saveForm.mock.calls[0][1]).toMatchObject({copySource:{id:41,files:{}},values:{paymentQr:[99]}});
});

it('复制窗口移除原收款码后保存不克隆且保持银行原值',async()=>{
 const row=copiedSupplier();render(<RecordForm def={getResourceDef('finance-suppliers')!} record={null} initial={copyInitialOf(getResourceDef('finance-suppliers')!,row)} onClose={()=>undefined} onSaved={()=>undefined}/>);
 fireEvent.click(screen.getByRole('button',{name:'移除 原收款码.png'}));expect(screen.queryByText('原收款码.png')).toBeNull();
 fireEvent.submit(document.querySelector('form')!);await waitFor(()=>expect(mocks.saveForm).toHaveBeenCalled());expect(mocks.saveForm.mock.calls[0][1]).toMatchObject({copySource:{files:{}},values:{paymentQr:[],bankAccountNo:'6222123456789000'}});
});
