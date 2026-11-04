import {render,cleanup,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,it,vi,expect} from 'vitest';
import {DesktopAfterSalesCollector} from './DesktopAfterSalesCollector';
import {api} from '../../api/client';
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:1},loading:false,can:()=>true})}));
vi.mock('../../api/client',()=>({api:vi.fn(),tokenStore:{get:()=> 'test-identity'}}));
const mock=vi.mocked(api);
const lease={sourceId:1,sourceCompany:'演示公司',token:'test-lease',page:1,from:'2026-11-04T00:00:00Z',until:'2026-11-04T01:00:00Z'};
beforeEach(()=>{
 window.oaDesktop={preferences:vi.fn().mockResolvedValue({collection:{clientId:'test-client',enabled:true,sourceCompany:'演示公司'}}),prepareLatest:vi.fn(),latest:vi.fn().mockResolvedValue({records:[],page:1,hasNext:false})} as unknown as NonNullable<Window['oaDesktop']>;
 mock.mockImplementation(async path=>path==='/desktop-after-sales-collection'?[{id:1,sourceCompany:'演示公司',enabled:true}]:path.endsWith('/claim')?lease:{});
});
afterEach(()=>{cleanup();delete window.oaDesktop;vi.restoreAllMocks();mock.mockReset();});
it('一个客户端连续完成同一轮最新分页，后台不提交历史查询任务',async()=>{
 vi.mocked(window.oaDesktop!.latest!).mockResolvedValueOnce({records:[],page:1,pageSize:50,total:51,hasNext:true,sourceCompany:'演示公司',kind:'current'}).mockResolvedValueOnce({records:[],page:2,pageSize:50,total:51,hasNext:false,sourceCompany:'演示公司',kind:'current'});
 render(<DesktopAfterSalesCollector/>);
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales-collection/1/commit',expect.objectContaining({body:expect.objectContaining({page:2,completed:true})})));
 expect(mock.mock.calls.filter(([p])=>p.endsWith('/claim'))).toHaveLength(1);
 expect(vi.mocked(window.oaDesktop!.latest!).mock.calls.map(([q])=>[q.kind,q.page])).toEqual([['current',1],['current',2]]);
});
it('读取失败必须上报失败，不会把本轮标为成功',async()=>{
 vi.mocked(window.oaDesktop!.latest!).mockRejectedValue(new Error('聚水潭登录失效'));
 render(<DesktopAfterSalesCollector/>);
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales-collection/1/fail',expect.objectContaining({body:expect.objectContaining({message:'聚水潭登录失效'})})));
 expect(mock.mock.calls.some(([p])=>p.endsWith('/commit'))).toBe(false);
});
