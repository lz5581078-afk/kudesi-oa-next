import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {FeeBookingNodeCell} from './FeeBookingNodeCell';
import {resourceApi,type ResourceDto} from './api';
const auth=vi.hoisted(()=>({companyId:1,id:1,permissions:{isCompanyAdmin:false,allow:['resource.finance-fee-items.view','resource.finance-fee-items.edit'],deny:[] as string[]}}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:auth})}));
vi.mock('./api',()=>({resourceApi:{get:vi.fn(),saveForm:vi.fn()}}));
const row:ResourceDto={id:987,type:'finance-fee-items',title:'合成费用',data:{name:'合成费用',defaultObject:'公司'},status:'active',statusReason:null,files:{},refLabels:{},secretConfigured:{},createdAt:'',updatedAt:'',version:'synthetic-v1'};
beforeEach(()=>{vi.resetAllMocks();auth.companyId=1;auth.permissions.deny=[];vi.mocked(resourceApi.get).mockResolvedValue({...row,data:{...row.data,defaultObject:'店铺、公司',relationRequirement:'原说明'}});vi.mocked(resourceApi.saveForm).mockResolvedValue(row);});
afterEach(cleanup);
const open=()=>fireEvent.click(screen.getByRole('button',{name:'修改合成费用挂账节点'}));
it('列表专属入口不打开整条详情，读取新值、多选与不固定，只有明确保存才写两字段',async()=>{
 const onOpen=vi.fn(),saved=vi.fn();render(<div onClick={onOpen}><FeeBookingNodeCell record={row} onSaved={saved}/></div>);open();
 const dialog=await screen.findByRole('dialog',{name:'选择挂账节点'});await screen.findByDisplayValue('原说明');
 expect(resourceApi.saveForm).not.toHaveBeenCalled();expect(onOpen).not.toHaveBeenCalled();
 expect(within(dialog).getAllByRole('button').filter(button=>button.hasAttribute('aria-pressed')).map(button=>button.querySelector('strong')?.textContent)).toEqual(['部门','人员','营业执照','税务','商标','店铺','手机号','宽带账号','自媒体账号','账号与服务备忘','公司公户','公司银行卡','公司出纳账户','店铺公户','店铺个人银行卡','固定资产','房间与档案位置','商品','供应商','客户','快递网点','项目','公司','不固定']);
 expect(within(dialog).getByRole('button',{name:/^店铺\s*费用单/}).getAttribute('aria-pressed')).toBe('true');
 fireEvent.click(within(dialog).getByRole('button',{name:/^不固定/}));expect(within(dialog).getByRole('button',{name:/^店铺\s*费用单/}).getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(within(dialog).getByRole('button',{name:/^店铺\s*费用单/}));fireEvent.change(within(dialog).getByLabelText('挂账节点说明'),{target:{value:'挂真实店铺'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'保存挂账节点'}));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
 expect(resourceApi.saveForm).toHaveBeenCalledWith('finance-fee-items',{id:987,version:'synthetic-v1',requestKey:expect.any(String),values:{defaultObject:'店铺',relationRequirement:'挂真实店铺'},collections:[]});expect(onOpen).not.toHaveBeenCalled();
});
it('保存失败保留修改、可同请求重试；保存中重复点击和关闭不会再发',async()=>{
 vi.mocked(resourceApi.saveForm).mockRejectedValueOnce(new Error('合成保存失败'));render(<FeeBookingNodeCell record={row}/>);open();await screen.findByDisplayValue('原说明');
 fireEvent.change(screen.getByLabelText('挂账节点说明'),{target:{value:'尚未保存说明'}});fireEvent.click(screen.getByRole('button',{name:'保存挂账节点'}));await screen.findByRole('alert');expect(screen.getByDisplayValue('尚未保存说明')).toBeTruthy();
 let finish!:(value:ResourceDto)=>void;vi.mocked(resourceApi.saveForm).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 fireEvent.click(screen.getByRole('button',{name:'保存挂账节点'}));fireEvent.click(screen.getByRole('button',{name:'保存挂账节点'}));
 expect(resourceApi.saveForm).toHaveBeenCalledTimes(2);expect(vi.mocked(resourceApi.saveForm).mock.calls[1][1].requestKey).toBe(vi.mocked(resourceApi.saveForm).mock.calls[0][1].requestKey);
 expect((screen.getByRole('button',{name:'关闭'}) as HTMLButtonElement).disabled).toBe(true);await act(async()=>finish(row));expect(screen.queryByRole('dialog')).toBeNull();
});
it('取消不写入；公司切换清掉打开的窗口和迟到结果；无编辑权限只有原显示',async()=>{
 const view=render(<FeeBookingNodeCell record={row}/>);open();await screen.findByDisplayValue('原说明');fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(resourceApi.saveForm).not.toHaveBeenCalled();
 let finish!:(value:ResourceDto)=>void;vi.mocked(resourceApi.get).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));open();
 auth.companyId=2;view.rerender(<FeeBookingNodeCell record={row}/>);await act(async()=>finish({...row,title:'旧公司迟到费用'}));expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByText(/旧公司迟到/)).toBeNull();
 auth.permissions.deny=['resource.finance-fee-items.edit'];view.rerender(<FeeBookingNodeCell record={row}/>);expect(screen.queryByRole('button')).toBeNull();expect(screen.getByText('公司')).toBeTruthy();
});
