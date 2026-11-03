import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OPENING_PREPAYMENT_PERMISSION } from '@kudesi/shared';
import { OpeningPrepaymentDialog } from './OpeningPrepaymentDialog';
import { DocDetail } from './DocDetail';
import { financeApi, type DocDetailDto } from './financeApi';

const createPreview=vi.fn(),revokePreview=vi.fn();
Object.defineProperty(URL,'createObjectURL',{value:createPreview,writable:true,configurable:true});
Object.defineProperty(URL,'revokeObjectURL',{value:revokePreview,writable:true,configurable:true});
let allowed: string[] = [];
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: (key: string) => allowed.includes(key) }) }));
vi.mock('./financeApi', () => ({ financeApi: { doc: vi.fn(), uploadOpeningVoucher: vi.fn(), registerOpeningPrepayment: vi.fn(), openingVoucherUrl: vi.fn() } }));
const doc = { id: 5, docNo: 'YF20261026001', docType: 'prepayment', typeLabel: '预付款单', status: 'issued', sourceKey: null, partyKind: 'supplier', partyName: '测试供应商', amountCents: 10000, paidCents: 0, offsetCents: 0, accounts: [], lines: [], entries: [], events: [] } as unknown as DocDetailDto;
beforeEach(() => { vi.resetAllMocks(); createPreview.mockImplementation((file:File)=>`blob:synthetic-${file.name}`); allowed = []; vi.mocked(financeApi.doc).mockResolvedValue(doc); });
afterEach(cleanup);

it('只有有独立权限的已开立手工供应商预付款显示入口', async () => {
  allowed = ['finance.docs.post'];
  const first = render(<DocDetail id={5} onClose={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText(doc.docNo);
  expect(screen.queryByRole('button', { name: '登记已有预付款余额' })).toBeNull();
  first.unmount();
  allowed = [OPENING_PREPAYMENT_PERMISSION];
  render(<DocDetail id={5} onClose={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '登记已有预付款余额' }));
  expect(screen.getByRole('dialog', { name: '登记已有预付款余额' })).toBeTruthy();
});

it.each([{ status: 'draft' }, { status: 'posted' }, { sourceKey: 'flow:1' }, { docType: 'payment' }, { amountCents: 0 }, { partyKind: 'customer' }])('不适用的单据隐藏入口 %j', async (patch) => {
  allowed = [OPENING_PREPAYMENT_PERMISSION];
  vi.mocked(financeApi.doc).mockResolvedValue({ ...doc, ...patch } as DocDetailDto);
  render(<DocDetail id={5} onClose={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText(doc.docNo);
  expect(screen.queryByRole('button', { name: '登记已有预付款余额' })).toBeNull();
});

it('核对说明、凭证和确认均满足后才可登记，并提交真实上传的文件ID', async () => {
  const saved = vi.fn();
  vi.mocked(financeApi.uploadOpeningVoucher).mockResolvedValue({ id: 7, name: '回单.pdf', mime: 'application/pdf', size: 100 });
  vi.mocked(financeApi.registerOpeningPrepayment).mockResolvedValue({ ...doc, status: 'posted' });
  render(<OpeningPrepaymentDialog doc={doc} onClose={vi.fn()} onSaved={saved} />);
  const submit = screen.getByRole('button', { name: '确认登记' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('核对说明（必填）'), { target: { value: '核对回单' } });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(submit.disabled).toBe(true);
  const file = new File(['%PDF-1.4'], '回单.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText(/凭证附件/), { target: { files: [file] } });
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(saved).toHaveBeenCalledWith(expect.objectContaining({ status: 'posted' })));
  expect(financeApi.uploadOpeningVoucher).toHaveBeenCalledWith(5, file);
  expect(financeApi.registerOpeningPrepayment).toHaveBeenCalledWith(5, { reason: '核对回单', fileIds: [7], confirmed: true });
});

it('上传失败保留错误且不能登记', async () => {
  vi.mocked(financeApi.uploadOpeningVoucher).mockRejectedValue(new Error('还没有配置七牛云存储'));
  render(<OpeningPrepaymentDialog doc={doc} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/凭证附件/), { target: { files: [new File(['bad'], '回单.pdf',{type:'application/pdf'})] } });
  expect((await screen.findByRole('alert')).textContent).toContain('七牛');
  expect((screen.getByRole('button', { name: '确认登记' }) as HTMLButtonElement).disabled).toBe(true);
  expect(financeApi.registerOpeningPrepayment).not.toHaveBeenCalled();
});

it('服务端拒绝后保留说明和附件，允许核对后重试', async () => {
  vi.mocked(financeApi.uploadOpeningVoucher).mockResolvedValue({ id: 7, name: '回单.pdf', mime: 'application/pdf', size: 100 });
  vi.mocked(financeApi.registerOpeningPrepayment).mockRejectedValue(new Error('单据已入账'));
  render(<OpeningPrepaymentDialog doc={doc} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('核对说明（必填）'), { target: { value: '核对回单' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText(/凭证附件/), { target: { files: [new File(['%PDF-1.4'], '回单.pdf',{type:'application/pdf'})] } });
  await waitFor(() => expect((screen.getByRole('button', { name: '确认登记' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
  expect((await screen.findByRole('alert')).textContent).toContain('单据已入账');
  expect((screen.getByLabelText('核对说明（必填）') as HTMLTextAreaElement).value).toBe('核对回单');
  expect(screen.getByText('回单.pdf')).toBeTruthy();
});

it('原查看窗口内直接填写预付款核对和凭证，明确按钮确认；失败可重试且不重复提交',async()=>{
  allowed=[OPENING_PREPAYMENT_PERMISSION];const close=vi.fn(),changed=vi.fn();
  vi.mocked(financeApi.uploadOpeningVoucher).mockResolvedValue({id:17,name:'合成回单.pdf',mime:'application/pdf',size:20});
  let fail!:(error:unknown)=>void;
  vi.mocked(financeApi.registerOpeningPrepayment).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));
  render(<DocDetail id={5} presentation="reference" onClose={close} onChanged={changed}/>);
  const input=await screen.findByLabelText('预付款期初核对说明');
  expect(screen.queryByRole('checkbox')).toBeNull();
  const submit=screen.getByRole('button',{name:'确认预付款余额并入账'});expect(submit).toHaveProperty('disabled',true);
  fireEvent.change(input,{target:{value:' 合成核对说明 '}});
  fireEvent.change(screen.getByLabelText('已有预付款凭证'),{target:{files:[new File(['%PDF'],'合成回单.pdf',{type:'application/pdf'})]}});
  await waitFor(()=>expect(submit).toHaveProperty('disabled',false));
  fireEvent.click(submit);fireEvent.submit(screen.getByRole('group',{name:'登记已有预付款余额'}));
  expect(financeApi.registerOpeningPrepayment).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button',{name:'关闭'})).toHaveProperty('disabled',true);
  fireEvent.keyDown(screen.getByRole('dialog',{name:'预付款单'}),{key:'Escape'});expect(close).not.toHaveBeenCalled();
  await act(async()=>fail(new Error('合成凭证校验失败')));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','合成凭证校验失败');
  expect(input).toHaveProperty('value',' 合成核对说明 ');expect(screen.getByText('合成回单.pdf')).toBeTruthy();
  vi.mocked(financeApi.registerOpeningPrepayment).mockResolvedValueOnce({...doc,status:'posted',entries:[{id:'1',kind:'opening',accountId:0,accountName:'',subId:0,amountCents:10000,qty:null}]});
  fireEvent.click(screen.getByRole('button',{name:'确认预付款余额并入账'}));
  await screen.findByText('已有预付款余额已入账，可在采购流程中选择使用。');
  expect(financeApi.registerOpeningPrepayment).toHaveBeenLastCalledWith(5,{reason:'合成核对说明',fileIds:[17],confirmed:true});
  expect(changed).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'关闭'})).toHaveProperty('disabled',false);
});
it('查看窗口复用权限和来源限制，不为流程预付款露出手工期初入口',async()=>{
  allowed=[OPENING_PREPAYMENT_PERMISSION];vi.mocked(financeApi.doc).mockResolvedValue({...doc,sourceKey:'flow:synthetic'});
  render(<DocDetail id={5} presentation="reference" onClose={vi.fn()} onChanged={vi.fn()}/>);await screen.findByText('YF20261026001 · 未过账');
  expect(screen.queryByLabelText('预付款期初核对说明')).toBeNull();
});
it('上传期间窗口卸载后停止后续文件请求，不把旧结果写回新上下文',async()=>{
  let finish!:(value:{id:number;name:string;mime:string;size:number})=>void;
  vi.mocked(financeApi.uploadOpeningVoucher).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const saved=vi.fn();const view=render(<OpeningPrepaymentDialog doc={doc} inline onClose={vi.fn()} onSaved={saved}/>);
  fireEvent.change(screen.getByLabelText('已有预付款凭证'),{target:{files:[new File(['a'],'合成甲.pdf',{type:'application/pdf'}),new File(['b'],'合成乙.pdf',{type:'application/pdf'})]}});
  view.unmount();await act(async()=>finish({id:17,name:'合成甲.pdf',mime:'application/pdf',size:1}));
  expect(financeApi.uploadOpeningVoucher).toHaveBeenCalledTimes(1);expect(saved).not.toHaveBeenCalled();
});
it('登记迟到成功不调用已卸载窗口的回调',async()=>{
  let finish!:(value:DocDetailDto)=>void;
  vi.mocked(financeApi.uploadOpeningVoucher).mockResolvedValue({id:17,name:'合成.pdf',mime:'application/pdf',size:1});
  vi.mocked(financeApi.registerOpeningPrepayment).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const saved=vi.fn();const view=render(<OpeningPrepaymentDialog doc={doc} inline onClose={vi.fn()} onSaved={saved}/>);
  fireEvent.change(screen.getByLabelText('预付款期初核对说明'),{target:{value:'合成核对'}});
  fireEvent.change(screen.getByLabelText('已有预付款凭证'),{target:{files:[new File(['a'],'合成.pdf',{type:'application/pdf'})]}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'确认预付款余额并入账'})).toHaveProperty('disabled',false));
  fireEvent.click(screen.getByRole('button',{name:'确认预付款余额并入账'}));view.unmount();await act(async()=>finish({...doc,status:'posted'}));
  expect(saved).not.toHaveBeenCalled();
});

it('原附件每批先校验类型/2MB及12份总数，混合非法文件不先上传有效部分',async()=>{
 render(<OpeningPrepaymentDialog doc={doc} inline onClose={vi.fn()} onSaved={vi.fn()}/>);
 const input=screen.getByLabelText('已有预付款凭证');
 fireEvent.change(input,{target:{files:[new File(['%PDF-'],'有效.pdf',{type:'application/pdf'}),new File(['GIF89a'],'多余.gif',{type:'image/gif'})]}});
 expect((await screen.findByRole('alert')).textContent).toContain('不超过2MB');expect(financeApi.uploadOpeningVoucher).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{files:[new File([new Uint8Array(2*1024*1024+1)],'过大.pdf',{type:'application/pdf'})]}});
 expect(financeApi.uploadOpeningVoucher).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{files:Array.from({length:13},(_,i)=>new File(['%PDF-'],i+'.pdf',{type:'application/pdf'}))}});
 expect(screen.getByRole('alert').textContent).toContain('最多12份');expect(financeApi.uploadOpeningVoucher).not.toHaveBeenCalled();
});
it('12份可以登记，选择后可预览/删除，移除和卸载释放临时链接',async()=>{
 let id=0;vi.mocked(financeApi.uploadOpeningVoucher).mockImplementation(async(_doc,file)=>({id:++id,name:file.name,mime:file.type,size:file.size}));
 const saved=vi.fn();vi.mocked(financeApi.registerOpeningPrepayment).mockResolvedValue({...doc,status:'posted'});
 const view=render(<OpeningPrepaymentDialog doc={doc} inline onClose={vi.fn()} onSaved={saved}/>);
 const input=screen.getByLabelText('已有预付款凭证');const file=(name:string)=>new File(['%PDF-'],name,{type:'application/pdf'});
 fireEvent.change(input,{target:{files:Array.from({length:12},(_,i)=>file('合成'+i+'.pdf'))}});
 await screen.findByRole('link',{name:'合成11.pdf'});expect(screen.getByRole('link',{name:'合成0.pdf'}).getAttribute('href')).toBe('blob:synthetic-合成0.pdf');
 fireEvent.change(input,{target:{files:[file('第十三份.pdf')]}});expect(screen.getByRole('alert').textContent).toContain('最多12份');expect(financeApi.uploadOpeningVoucher).toHaveBeenCalledTimes(12);
 fireEvent.click(screen.getByRole('button',{name:'删除合成0.pdf'}));expect(revokePreview).toHaveBeenCalledWith('blob:synthetic-合成0.pdf');expect(screen.queryByRole('link',{name:'合成0.pdf'})).toBeNull();
 fireEvent.change(input,{target:{files:[file('替换凭证.pdf')]}});await screen.findByRole('link',{name:'替换凭证.pdf'});
 fireEvent.change(screen.getByLabelText('预付款期初核对说明'),{target:{value:'核对十二份凭证'}});fireEvent.click(screen.getByRole('button',{name:'确认预付款余额并入账'}));
 await waitFor(()=>expect(saved).toHaveBeenCalled());expect(financeApi.registerOpeningPrepayment).toHaveBeenCalledWith(5,{reason:'核对十二份凭证',fileIds:Array.from({length:12},(_,i)=>i+2),confirmed:true});
 view.unmount();expect(revokePreview).toHaveBeenCalledTimes(13);
});
