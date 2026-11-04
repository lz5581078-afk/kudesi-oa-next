import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {getResourceDef} from '@kudesi/shared';
const mocks=vi.hoisted(()=>({batch:vi.fn(),load:vi.fn()}));
vi.mock('./api',()=>({resourceApi:{batch:mocks.batch}}));
vi.mock('./RecordForm',()=>({loadRefOptions:mocks.load}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:7,companyId:3,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
import {BatchBar} from './BatchBar';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('费用移动只写单值categoryId，初始当前目录；失败保持窗口，不提交往来多选字段',async()=>{
 mocks.load.mockResolvedValue([{value:8,label:'运行支撑费用 / 办公用品'},{value:9,label:'其他支出'}]);mocks.batch.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({done:1,failed:[]});const done=vi.fn();
 render(<BatchBar referenceArchive currentCategoryId={8} allowDelete def={getResourceDef('finance-fee-items')!} type="finance-fee-items" rows={[]} checked={[701]} can={()=>true} filterOpts={{}} onMessage={vi.fn()} onDone={done} onExport={vi.fn()} onClear={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'移动分类 1'}));await screen.findByRole('option',{name:'运行支撑费用 / 办公用品'});expect(mocks.load.mock.calls[0][0]).toBe('finance-fee-categories');expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('8');
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'9'}});fireEvent.click(screen.getByRole('button',{name:'确认移动'}));await screen.findByText('移动失败');expect(done).not.toHaveBeenCalled();expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('9');
 fireEvent.click(screen.getByRole('button',{name:'确认移动'}));await waitFor(()=>expect(done).toHaveBeenCalledOnce());expect(mocks.batch).toHaveBeenLastCalledWith('finance-fee-items',[701],{categoryId:9});
});
