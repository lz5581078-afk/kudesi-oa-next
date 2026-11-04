import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({check:vi.fn(),user:{id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:mocks.user})}));
vi.mock('./api',()=>({resourceApi:{similarCheck:mocks.check}}));
import {ArchiveSimilarityNotice} from './ArchiveSimilarityNotice';
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.user={...mocks.user,companyId:1};});
it('原实时警告显示最多三项，未填名/自动编号未就绪时不猜重复，不传银行账号/附件',async()=>{
 mocks.check.mockResolvedValue({blocked:[],warnings:Array.from({length:5},(_,i)=>({text:'相似资料'+i}))});
 const values={name:'合成供应商',bankAccountNo:'不应进入查重请求',paymentQr:[7]},view=render(<ArchiveSimilarityNotice type="finance-suppliers" values={values}/>);
 expect(mocks.check).not.toHaveBeenCalled();view.rerender(<ArchiveSimilarityNotice type="finance-suppliers" values={values} previewCode="GYS-NEW"/>);
 await screen.findByText('发现可能相似的资料');expect(screen.getByText('相似资料2')).toBeTruthy();expect(screen.queryByText('相似资料3')).toBeNull();expect(screen.getByText('请核对后再保存；相似资料可以确认后继续。')).toBeTruthy();
 const input=mocks.check.mock.calls[0][1];expect(input.code).toBe('GYS-NEW');expect(input).not.toHaveProperty('bankAccountNo');expect(input).not.toHaveProperty('paymentQr');
});
it('旧公司迟到/旧字段响应不显示，真正阻止项恢复原红色文案',async()=>{
 let oldResolve!:(value:unknown)=>void;
 mocks.check.mockReturnValueOnce(new Promise(resolve=>{oldResolve=resolve;})).mockResolvedValueOnce({blocked:[{text:'编号完全相同'}],warnings:[]});
 const view=render(<ArchiveSimilarityNotice type="finance-fee-items" values={{name:'合成费用'}} previewCode="FY-1"/>);await waitFor(()=>expect(mocks.check).toHaveBeenCalledTimes(1));
 mocks.user={...mocks.user,companyId:2};view.rerender(<ArchiveSimilarityNotice type="finance-fee-items" values={{name:'当前费用'}} previewCode="FY-2"/>);
 await screen.findByText('发现完全相同的资料，禁止保存');await act(async()=>oldResolve({blocked:[],warnings:[{text:'旧公司的资料'}]}));expect(screen.queryByText('旧公司的资料')).toBeNull();expect(screen.queryByText('请核对后再保存；相似资料可以确认后继续。')).toBeNull();
});
