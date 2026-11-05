import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getResourceDef} from '@kudesi/shared';
import {resourceApi,type ResourceDto} from './api';
import {HierRowActions} from './HierRowActions';
vi.mock('./RecordForm',()=>({clearRefCache:vi.fn(),ReasonDialog:()=> <div>通用原因表单</div>}));
vi.mock('./api',()=>({resourceApi:{remove:vi.fn(),changeStatus:vi.fn()}}));
const row:ResourceDto={id:41,type:'finance-products',title:'合成原料',status:'active',statusReason:null,version:'version-41',data:{archiveType:'raw'},refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''};
const done=vi.fn();
const show=(record=row)=>{const view=render(<HierRowActions def={getResourceDef('finance-products')!} row={record} can={()=>true} onOpen={vi.fn()} onEdit={vi.fn()} onCopy={vi.fn()} onDone={done}/>);fireEvent.click(screen.getByRole('button',{name:`操作：${record.title}`}));return view;};
beforeEach(()=>{vi.mocked(resourceApi.changeStatus).mockResolvedValue(row);vi.mocked(resourceApi.remove).mockResolvedValue({ok:true});});
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('停用仅要求非空原因，失败保留输入并可重试',async()=>{vi.mocked(resourceApi.changeStatus).mockRejectedValueOnce(new Error('合成保存失败'));show();fireEvent.click(screen.getByRole('button',{name:'停用：合成原料'}));expect(screen.queryByText('通用原因表单')).toBeNull();fireEvent.change(screen.getByRole('textbox',{name:'停用原因'}),{target:{value:'  停  '}});fireEvent.click(screen.getByRole('button',{name:'确认停用'}));await screen.findByText('合成保存失败');expect((screen.getByRole('textbox',{name:'停用原因'}) as HTMLTextAreaElement).value).toBe('  停  ');expect(done).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'确认停用'}));await waitFor(()=>expect(done).toHaveBeenCalledTimes(1));expect(resourceApi.changeStatus).toHaveBeenLastCalledWith('finance-products',41,'inactive','停');});
it('启用不渲染原因且不向服务伪造原因',async()=>{show({...row,status:'inactive'});fireEvent.click(screen.getByRole('button',{name:'启用：合成原料'}));expect(screen.queryByRole('textbox')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'确认启用'}));await waitFor(()=>expect(resourceApi.changeStatus).toHaveBeenCalledWith('finance-products',41,'active',undefined));});
it('删除沿实际版本和原引用保护，冲突失败不关闭或刷新',async()=>{vi.mocked(resourceApi.remove).mockRejectedValueOnce(new Error('资料已修改，请刷新后重试'));show();fireEvent.click(screen.getByRole('button',{name:'删除：合成原料'}));expect(screen.queryByRole('textbox')).toBeNull();expect(screen.getByText(/基础编码、BOM、包装方案或成本快照/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'确认彻底删除'}));await screen.findByText('资料已修改，请刷新后重试');expect(resourceApi.remove).toHaveBeenCalledWith('finance-products',41,'财务商品档案页面删除','version-41');expect(done).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'确认彻底删除商品'})).toBeTruthy();});

it('初始只占一个按钮，展开保留权限边界且选项点击后关闭',()=>{
 const open=vi.fn(),edit=vi.fn();render(<HierRowActions def={getResourceDef('finance-products')!} row={row} can={a=>a==='edit'} onOpen={open} onEdit={edit} onCopy={vi.fn()} onDone={done}/>);
 expect(screen.queryByRole('button',{name:'编辑：合成原料'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'操作：合成原料'}));
 expect(screen.queryByRole('button',{name:'删除：合成原料'})).toBeNull();expect(screen.queryByRole('button',{name:'复制新增：合成原料'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'编辑：合成原料'}));expect(edit).toHaveBeenCalledWith(row);expect(open).not.toHaveBeenCalled();expect(screen.queryByRole('dialog',{name:'操作：合成原料'})).toBeNull();
});
it('Escape返回触发按钮，点击外部与滚动关闭菜单',()=>{
 show();const trigger=screen.getByRole('button',{name:'操作：合成原料'});
 fireEvent.keyDown(document,{key:'Escape'});expect(document.activeElement).toBe(trigger);expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.click(trigger);fireEvent.pointerDown(document.body);expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.click(trigger);fireEvent.scroll(window);expect(screen.queryByRole('dialog')).toBeNull();
});
