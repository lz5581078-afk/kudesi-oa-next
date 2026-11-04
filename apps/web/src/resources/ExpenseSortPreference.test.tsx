import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {api} from '../api/client';
import {ExpenseSortProvider,useExpenseSortPreference} from './ExpenseSortPreference';
const auth={user:{id:4,companyId:2,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}};
vi.mock('../auth/AuthContext',()=>({useAuth:()=>auth}));vi.mock('../api/client',async orig=>({...await orig<typeof import('../api/client')>(),api:vi.fn()}));
const request=vi.mocked(api);function Probe(){const sort=useExpenseSortPreference();return <><output>{JSON.stringify(sort?.value)}</output><button onClick={()=>sort?.move('categoryOrders','root',[1,2,3],3,1)}>先移三</button><button onClick={()=>sort?.move('categoryOrders','root',[1,2,3],2,3)}>再移二</button></>;}
beforeEach(()=>{auth.user.id=4;});afterEach(()=>{cleanup();vi.resetAllMocks();});
it('迟到读取不盖过本人的拖动，快速连续写入按顺序发送，不重写共享分类',async()=>{
 let resolveRead!:(value:unknown)=>void,resolveWrite!:(value:unknown)=>void;request.mockImplementation((_path,opts)=>{if(!opts?.method)return new Promise(resolve=>{resolveRead=resolve;});if(request.mock.calls.filter(([,o])=>o?.method==='PUT').length===1)return new Promise(resolve=>{resolveWrite=resolve;});return Promise.resolve({}) as never;});
 render(<ExpenseSortProvider enabled><Probe/></ExpenseSortProvider>);fireEvent.click(screen.getByRole('button',{name:'先移三'}));fireEvent.click(screen.getByRole('button',{name:'再移二'}));await waitFor(()=>expect(request.mock.calls.filter(([,o])=>o?.method==='PUT')).toHaveLength(1));await act(async()=>resolveRead({value:{categoryOrders:{root:['1','2','3']}}}));expect(screen.getByRole('status').textContent).toContain('"root":["2","3","1"]');await act(async()=>resolveWrite({}));await waitFor(()=>expect(request.mock.calls.filter(([,o])=>o?.method==='PUT')).toHaveLength(2));expect(request).toHaveBeenLastCalledWith('/user-preferences/finance-expense-sort-v1',{method:'PUT',body:{value:{categoryOrders:{root:['2','3','1']},itemOrders:{}}}});
});
it('切换本人身份会隔离旧读取和顺序，关闭页面不继续发送排队中的旧身份请求',async()=>{
 let resolveOld!:(value:unknown)=>void;request.mockImplementation((_path,opts)=>{if(opts?.method)return Promise.resolve({}) as never;if(request.mock.calls.length===1)return new Promise(resolve=>{resolveOld=resolve;});return Promise.resolve({value:{categoryOrders:{root:['2','1']},itemOrders:{}}}) as never;});
 const view=render(<ExpenseSortProvider enabled><Probe/></ExpenseSortProvider>);auth.user.id=5;view.rerender(<ExpenseSortProvider enabled><Probe/></ExpenseSortProvider>);await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('"root":["2","1"]'));await act(async()=>resolveOld({value:{categoryOrders:{root:['3','1']},itemOrders:{}}}));expect(screen.getByRole('status').textContent).not.toContain('"3","1"');
 cleanup();expect(request.mock.calls.some(([,o])=>o?.method)).toBe(false);
});
