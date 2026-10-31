import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { JstUploadPage } from './JstUploadPage';
import { jstApi } from './jstApi';

vi.mock('../../../auth/AuthContext',()=>({useAuth:()=>({user:{permissions:{isCompanyAdmin:true}}})}));
vi.mock('./jstApi',()=>({jstApi:{uploadLogs:vi.fn(),uploadOptions:vi.fn(),uploadCheck:vi.fn(),upload:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('资料维护记录与上传弹窗',()=>{
  it('主页面显示记录；填写表单只在弹窗中，关闭后回到入口',async()=>{
    vi.mocked(jstApi.uploadLogs).mockResolvedValue({total:1,rows:[{id:1,skuId:'SKU001',styleId:'STYLE001',name:'商品',status:'queued',message:'等待发送',createdAt:'2026-10-31T01:00:00Z'}]});
    vi.mocked(jstApi.uploadOptions).mockResolvedValue({categories:['苹果'],brands:['果园']});render(<JstUploadPage/>);
    await screen.findByText('SKU001');expect(screen.queryByLabelText(/颜色及规格/)).toBeNull();
    const entrance=screen.getByRole('button',{name:'上传普通商品资料'});entrance.focus();fireEvent.click(entrance);
    const dialog=await screen.findByRole('dialog',{name:'普通商品资料上传'});await within(dialog).findByRole('option',{name:'苹果'});
    expect(within(dialog).getByRole('button',{name:'查重并加入同步队列'}).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dialog).getByRole('button',{name:'关闭'}));expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(entrance);
    expect(jstApi.upload).not.toHaveBeenCalled();
  });
  it('搜索在提交后执行，刷新使用已提交条件',async()=>{
    vi.mocked(jstApi.uploadLogs).mockResolvedValue({total:0,rows:[]});render(<JstUploadPage/>);await waitFor(()=>expect(jstApi.uploadLogs).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('搜索上传记录'),{target:{value:'SKU002'}});expect(jstApi.uploadLogs).toHaveBeenCalledTimes(1);
    fireEvent.submit(screen.getByLabelText('搜索上传记录').closest('form')!);await waitFor(()=>expect(jstApi.uploadLogs).toHaveBeenLastCalledWith({keyword:'SKU002',page:1}));
    fireEvent.click(screen.getByRole('button',{name:'刷新记录'}));expect(jstApi.uploadLogs).toHaveBeenLastCalledWith({keyword:'SKU002',page:1});
  });
});
