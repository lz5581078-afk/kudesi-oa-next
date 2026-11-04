import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {CodeInactiveRecordsDialog} from './CodeInactiveRecordsDialog';
import {resourceApi,type ResourceDto} from '../../../resources/api';
vi.mock('../../../resources/api',()=>({resourceApi:{list:vi.fn(),changeStatus:vi.fn()}}));
vi.mock('../FinanceModal',()=>({FinanceModal:({children,title}:{children:React.ReactNode;title:string})=><div role="dialog"><h2>{title}</h2>{children}</div>}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('未知停用单独查询，显式启用调用既有状态接口并重新加载',async()=>{
 const row:ResourceDto={id:9,type:'finance-base-codes',title:'合成旧资料',status:'disabled',statusReason:null,data:{code:'HC-9'},refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''};
 vi.mocked(resourceApi.list).mockResolvedValue({items:[row],total:1,page:1,pageSize:30});vi.mocked(resourceApi.changeStatus).mockResolvedValue(row);const changed=vi.fn();
 render(<CodeInactiveRecordsDialog type="finance-base-codes" canEnable onClose={()=>{}} onChanged={changed}/>);
 await screen.findByText('HC-9');expect(resourceApi.list).toHaveBeenCalledWith('finance-base-codes',expect.objectContaining({showHidden:true,filters:{verificationState:'unknown',enabledState:'inactive'}}));
 fireEvent.click(screen.getByRole('button',{name:'启用并待验证'}));await waitFor(()=>expect(changed).toHaveBeenCalledOnce());expect(resourceApi.changeStatus).toHaveBeenCalledWith('finance-base-codes',9,'active');
});
it('没有启停权限只读保留记录，不提供状态操作',async()=>{vi.mocked(resourceApi.list).mockResolvedValue({items:[],total:0,page:1,pageSize:30});render(<CodeInactiveRecordsDialog type="finance-bundles" canEnable={false} onClose={()=>{}} onChanged={()=>{}}/>);await screen.findByText('暂无此类记录');expect(screen.queryByRole('button',{name:'启用并待验证'})).toBeNull();});
