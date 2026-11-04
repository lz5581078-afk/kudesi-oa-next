import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {BaseCodeDeletionHistory} from './BaseCodeDeletionHistory';
import {api} from '../../../api/client';
vi.mock('../../../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('../../../api/client',async original=>({...await original<typeof import('../../../api/client')>(),api:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('既有禁用事实读取和重试沿统一队列，不用当前连接猜历史账号',async()=>{vi.mocked(api).mockResolvedValue({rows:[{id:8,status:'failed',lastError:'合成错误',payload:{code:'HC-1',targetKey:'private-target-key'}}]});render(<BaseCodeDeletionHistory canRetry onClose={()=>{}}/>);await screen.findByText(/HC-1.*账号名称未记录/);expect(screen.queryByText(/private-target-key/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'重新核对'}));await waitFor(()=>expect(api).toHaveBeenCalledWith('/finance/jst-sync/jobs/8/retry',{method:'POST',body:{}}));});
it('无回查权限不显示写入口，读取失败不冒充空历史',async()=>{vi.mocked(api).mockRejectedValue(new Error('真实读取失败'));render(<BaseCodeDeletionHistory canRetry={false} onClose={()=>{}}/>);await screen.findByRole('alert');expect(screen.queryByText('暂无删除记录')).toBeNull();expect(screen.queryByRole('button',{name:'重新核对'})).toBeNull();});
