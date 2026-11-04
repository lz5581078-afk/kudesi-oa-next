import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import {RESOURCE_IMPORT_PROFILES,type ResourceImportProfile} from '@kudesi/shared';
import {MasterImportPage} from './MasterImportPage';
import {resourceApi} from '../../resources/api';
const auth=vi.hoisted(()=>({companyId:1,id:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:auth,can:()=>true})}));
vi.mock('../../resources/api',()=>({resourceApi:{importProfiles:vi.fn()}}));
vi.mock('../../resources/ProfileImportPanel',()=>({ProfileImportPanel:({profile,headerControl,onDone}:{profile:ResourceImportProfile;headerControl:ReactNode;onDone:(message:string)=>void})=><section aria-label="资料导入">{headerControl}<p>{profile.label} · 页内预检</p><button onClick={()=>onDone('新增 2，更新 1。')}>完成导入</button></section>}));
vi.mock('./DataToolPages',()=>({MasterResetPage:()=> <p>同页清理范围与快照</p>}));
beforeEach(()=>{vi.resetAllMocks();auth.companyId=1;vi.mocked(resourceApi.importProfiles).mockResolvedValue({profiles:[...RESOURCE_IMPORT_PROFILES]});});afterEach(cleanup);
it('读取原七类工作簿，在同页选择预检，成功清文件但保留类型及同页清理入口',async()=>{
  render(<MasterImportPage/>);await screen.findByText('商品档案分类 · 页内预检');
  expect(screen.getAllByRole('option')).toHaveLength(7);fireEvent.change(screen.getByLabelText('导入类型'),{target:{value:'base_codes'}});expect(screen.getByText('商品基础编码 · 页内预检')).toBeTruthy();expect(screen.getByText('同页清理范围与快照')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'完成导入'}));expect(screen.getByRole('status').textContent).toContain('新增 2');expect((screen.getByLabelText('导入类型') as HTMLSelectElement).value).toBe('base_codes');
});
it('类型读取失败必须重试，不用猜测资料类型；旧公司的迟到目录不能覆盖新公司',async()=>{
  vi.mocked(resourceApi.importProfiles).mockRejectedValueOnce(new Error('合成读取失败'));const view=render(<MasterImportPage/>);await screen.findByRole('alert');expect(screen.queryByLabelText('导入类型')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByLabelText('导入类型');view.unmount();
  let resolve!:(value:never)=>void;vi.mocked(resourceApi.importProfiles).mockReturnValueOnce(new Promise(done=>{resolve=done;}));const second=render(<MasterImportPage/>);auth.companyId=2;second.rerender(<MasterImportPage/>);await screen.findByLabelText('导入类型');fireEvent.change(screen.getByLabelText('导入类型'),{target:{value:'platforms'}});await act(async()=>resolve({profiles:[]} as never));await waitFor(()=>expect((screen.getByLabelText('导入类型') as HTMLSelectElement).value).toBe('platforms'));
});
