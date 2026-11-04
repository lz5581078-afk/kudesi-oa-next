import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({load:vi.fn()}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:7,companyId:3,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('./RecordForm',()=>({loadRefOptions:mocks.load}));
import {FinanceArchiveMoveDialog} from './FinanceArchiveMoveDialog';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('移动选择完整路径，不加原因；失败保留选择并可重试',async()=>{
 mocks.load.mockResolvedValue([{value:1,label:'店铺客户'},{value:2,label:'店铺客户 / 合成目录'}]);
 const confirm=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
 render(<FinanceArchiveMoveDialog type="finance-customers" count={2} onClose={vi.fn()} onConfirm={confirm}/>);
 await screen.findByRole('option',{name:'店铺客户 / 合成目录'});
 expect(mocks.load.mock.calls[0][1]).toContain('[3,7,true');
 expect(screen.queryByRole('textbox')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'确认移动'}));expect(confirm).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'2'}});
 fireEvent.click(screen.getByRole('button',{name:'确认移动'}));await screen.findByText('移动失败');
 expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('2');
 fireEvent.click(screen.getByRole('button',{name:'确认移动'}));await waitFor(()=>expect(confirm).toHaveBeenCalledTimes(2));expect(confirm).toHaveBeenLastCalledWith(2);
});
it('取消不提交批量修改',async()=>{
 mocks.load.mockResolvedValue([]);const close=vi.fn(),confirm=vi.fn();render(<FinanceArchiveMoveDialog type="finance-suppliers" count={1} onClose={close} onConfirm={confirm}/>);
 fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(close).toHaveBeenCalledOnce();expect(confirm).not.toHaveBeenCalled();
});

it('移动窗口默认当前分类，仍能选择父目录并沿同一保存入口提交',async()=>{
 mocks.load.mockResolvedValue([{value:1,label:'店铺客户'},{value:2,label:'店铺客户 / 合成目录'}]);const confirm=vi.fn().mockResolvedValue(undefined);
 render(<FinanceArchiveMoveDialog initialCategoryId={2} type="finance-customers" count={1} onClose={vi.fn()} onConfirm={confirm}/>);
 await screen.findByRole('option',{name:'店铺客户 / 合成目录'});expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('2');
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'确认移动'}));await waitFor(()=>expect(confirm).toHaveBeenCalledWith(1));
});
