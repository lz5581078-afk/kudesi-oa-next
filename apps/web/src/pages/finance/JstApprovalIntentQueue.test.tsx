import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {JstSyncPage} from './DataToolPages';
import {financeApi} from './financeApi';
vi.mock('./jst/JstSyncItems',()=>({JstSyncItems:()=>null}));
vi.mock('./jst/JstSyncExtras',()=>({JstSyncExtras:()=>null}));
vi.mock('./jst/FeishuSwitchCard',()=>({FeishuSwitchCard:()=>null}));
vi.mock('./financeApi',async original=>({...await original<typeof import('./financeApi')>(),financeApi:{jstSwitch:vi.fn(),jstJobs:vi.fn(),jstRetry:vi.fn()}}));
const service=vi.mocked(financeApi);
const blockedPayload={code:'SYNTHETIC-BLOCKED',name:'合成待处理',blockedIntent:true};
beforeEach(()=>{
 service.jstSwitch.mockResolvedValue({enabled:false,note:null,senderConfigured:false});
 service.jstJobs.mockResolvedValue({total:2,counts:{failed:2},rows:[{id:7,kind:'bundle_upsert',resourceType:'finance-bundles',resourceId:901,status:'failed',attempts:0,lastError:'聚水潭授权尚未配置',createdAt:'2026-10-24T10:00:00Z',doneAt:null,payload:blockedPayload},{id:8,kind:'bundle_upsert',resourceType:'finance-bundles',resourceId:902,status:'failed',attempts:2,lastError:'合成发送失败',createdAt:'2026-10-24T10:00:00Z',doneAt:null,payload:{code:'SYNTHETIC-FAILED',name:'合成已尝试'}}]});
 service.jstRetry.mockResolvedValue({ok:true});
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('审批意图主队列只改真实blockedIntent展示，failed筛选/实际0次和原retry请求保持',async()=>{
 render(<JstSyncPage/>);await screen.findByText('待处理配置/资料问题');const blocked=screen.getByRole('row',{name:/SYNTHETIC-BLOCKED/}),sentFailure=screen.getByRole('row',{name:/SYNTHETIC-FAILED/});expect(within(blocked).getByText('0')).toBeTruthy();expect(within(blocked).queryByText('失败')).toBeNull();expect(within(sentFailure).getByText('失败')).toBeTruthy();expect(within(sentFailure).getByText('2')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'失败 2'}));await waitFor(()=>expect(service.jstJobs).toHaveBeenCalledWith({status:'failed',page:1}));fireEvent.click(within(screen.getByRole('row',{name:/SYNTHETIC-BLOCKED/})).getByRole('button',{name:'重试'}));await waitFor(()=>expect(service.jstRetry).toHaveBeenCalledWith(7));expect(screen.getByText('待处理配置/资料问题')).toBeTruthy();
});
