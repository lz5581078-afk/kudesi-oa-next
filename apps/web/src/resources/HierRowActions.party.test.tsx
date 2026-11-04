import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {getResourceDef} from '@kudesi/shared';
const mocks=vi.hoisted(()=>({changeStatus:vi.fn(),remove:vi.fn()}));
vi.mock('./api',async orig=>{const m=await orig<typeof import('./api')>();return {...m,resourceApi:{...m.resourceApi,changeStatus:mocks.changeStatus,remove:mocks.remove}};});
import {HierRowActions} from './HierRowActions';
import type {ResourceDto} from './api';
afterEach(()=>{cleanup();vi.resetAllMocks();});
function show(status='active'){const done=vi.fn();render(<HierRowActions def={getResourceDef('finance-customers')!} row={{id:601,title:'合成客户',status,version:'0123456789abcdef',data:{},refLabels:{},files:{},secretConfigured:{}} as ResourceDto} can={()=>true} onOpen={()=>{}} onEdit={()=>{}} onCopy={()=>{}} onDone={done}/>);return done;}
it('财务列表停用使用原独立原因窗，失败保留原因可重试，单字非空即可',async()=>{
 mocks.changeStatus.mockRejectedValueOnce(new Error('合成失败')).mockResolvedValue({});show();
 fireEvent.click(screen.getByRole('button',{name:'停用：合成客户'}));
 const dialog=screen.getByRole('dialog',{name:'填写停用原因'});
 expect(within(dialog).queryByRole('group',{name:'常用原因'})).toBeNull();
 fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'停'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'确认提交'}));
 await screen.findByRole('alert');expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe('停');
 fireEvent.click(within(dialog).getByRole('button',{name:'确认提交'}));
 await waitFor(()=>expect(mocks.changeStatus).toHaveBeenCalledTimes(2));
 expect(mocks.changeStatus).toHaveBeenLastCalledWith('finance-customers',601,'inactive','停');
});
it('财务列表恢复启用直接沿原状态接口，不额外询问原本没有的原因',async()=>{
 mocks.changeStatus.mockResolvedValue({});const done=show('inactive');
 fireEvent.click(screen.getByRole('button',{name:'启用：合成客户'}));
 await waitFor(()=>expect(done).toHaveBeenCalled());
 expect(mocks.changeStatus).toHaveBeenCalledWith('finance-customers',601,'active');
 expect(screen.queryByRole('dialog')).toBeNull();
});

it('财务删除只显示原资料确认，取消不写，确认沿同版本删除与引用保护',async()=>{
 mocks.remove.mockResolvedValue({});show();
 fireEvent.click(screen.getByRole('button',{name:'删除：合成客户'}));
 let dialog=screen.getByRole('dialog',{name:'确认删除'});
 expect(within(dialog).queryByRole('textbox')).toBeNull();expect(within(dialog).getByText('合成客户')).toBeTruthy();
 fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));expect(mocks.remove).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'删除：合成客户'}));dialog=screen.getByRole('dialog',{name:'确认删除'});
 fireEvent.click(within(dialog).getByRole('button',{name:'确认删除'}));
 await waitFor(()=>expect(mocks.remove).toHaveBeenCalledWith('finance-customers',601,'财务档案页面删除','0123456789abcdef'));
});
