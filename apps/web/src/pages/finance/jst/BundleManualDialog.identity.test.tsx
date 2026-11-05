import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {resourceApi,type ResourceDto} from '../../../resources/api';
import {BundleManualDialog} from './BundleManualDialog';
vi.mock('../../../resources/api',()=>({resourceApi:{update:vi.fn(async()=>({}))}}));
const bundle=(status:string,data:Record<string,unknown>={}):ResourceDto=>({id:1,type:'finance-bundles',title:'原SKU',status,statusReason:null,data:{code:'SKU-ORIGINAL',styleCode:'STYLE-ORIGINAL',name:'旧名称',...data},refLabels:{},secretConfigured:{},files:{},createdAt:'',updatedAt:''});
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('组合编码固定、资料可维护',()=>{
 it('已验证并上传组合的编码只读，名称可改；提交不请求改号',async()=>{
  render(<BundleManualDialog bundle={bundle('verified',{jstUploadedCode:'SKU-ORIGINAL'})} onClose={vi.fn()} onDone={vi.fn()}/>);
  expect((screen.getByLabelText('组合编码') as HTMLInputElement).readOnly).toBe(true);expect((screen.getByLabelText('款式编码') as HTMLInputElement).readOnly).toBe(true);
  expect((screen.getByLabelText('组合名称') as HTMLInputElement).readOnly).toBe(false);fireEvent.change(screen.getByLabelText('组合名称'),{target:{value:'新名称'}});fireEvent.change(screen.getByLabelText('改码改名原因'),{target:{value:'更新资料名称'}});fireEvent.click(screen.getByRole('button',{name:'保存'}));
  await waitFor(()=>expect(resourceApi.update).toHaveBeenCalled());expect(vi.mocked(resourceApi.update).mock.calls[0][2]).toMatchObject({manualName:'新名称',manualCode:'',manualStyleCode:''});
  expect(screen.queryByText(/禁用旧编码、创建新编码/)).toBeNull();
 });
 it('尚未验证或上传的创建草稿允许完成首次编码',()=>{
  render(<BundleManualDialog bundle={bundle('pending')} onClose={vi.fn()} onDone={vi.fn()}/>);expect((screen.getByLabelText('组合编码') as HTMLInputElement).readOnly).toBe(false);
 });
});
