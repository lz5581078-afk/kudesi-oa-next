import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { FeeSnapshotsDialog } from './FeeSnapshotsDialog';

vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: vi.fn() }));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:4,companyId:2,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
const m = vi.mocked(api);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('费用档案存档表', () => {
  it('列出存档，填名称存档；恢复要确认，恢复后通知刷新', async () => {
    const snap = { id: 3, name: '改前', remark: '', auto: false, categoryCount: 140, itemCount: 378, createdAt: '2026-10-27T08:00:00Z', restoredAt: null };
    m.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.endsWith('/restore')) return { restored: 518, stopped: 2 } as never;
      if (opts?.method === 'POST') return { id: 4 } as never;
      return [snap] as never;
    });

    const onRestored = vi.fn();
    render(<FeeSnapshotsDialog embedded canWrite canDelete onClose={vi.fn()} onRestored={onRestored} />);
    await screen.findByText('改前');
    fireEvent.click(screen.getByRole('button',{name:'存为历史包'}));
    fireEvent.change(screen.getByLabelText('存档名称'), { target: { value: '整理前' } });
    fireEvent.click(screen.getByRole('button', { name: '保存历史包' }));
    await waitFor(() => expect(m).toHaveBeenCalledWith('/finance/fee-archive/snapshots', expect.objectContaining({ method: 'POST', body: { name: '整理前', remark: undefined } })));
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    fireEvent.click(screen.getByRole('button',{name:'确认恢复'}));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });
  it('没有写权限时不出现存档和恢复按钮', async () => {
    m.mockResolvedValue([] as never);
    render(<FeeSnapshotsDialog canWrite={false} canDelete={false} onClose={vi.fn()} onRestored={vi.fn()} />);
    await screen.findByText(/暂无存档/);
    expect(screen.queryByRole('button', { name: '存为历史包' })).toBeNull();
  });
});

it('主入口直接开原版保存窗，默认日期名称；保存失败保留输入重试，不混入历史列表',async()=>{
 m.mockImplementation(async(_path,opts)=>{if(opts?.method==='POST')throw new Error('offline');return [] as never;});const close=vi.fn();
 render(<FeeSnapshotsDialog createOnly canWrite canDelete onClose={close} onRestored={vi.fn()}/>);
 const input=screen.getByRole('textbox',{name:'存档名称'}) as HTMLInputElement;expect(input.value).toMatch(/^费用档案存档 \d{4}-\d{2}-\d{2}$/);
 expect(screen.queryByRole('table')).toBeNull();fireEvent.change(input,{target:{value:'修改前'}});fireEvent.change(screen.getByRole('textbox',{name:'备注'}),{target:{value:'合成调整原因'}});
 fireEvent.click(screen.getByRole('button',{name:'保存历史包'}));await screen.findByText('保存失败，请重试');expect(input.value).toBe('修改前');expect(close).not.toHaveBeenCalled();
 m.mockResolvedValue([] as never);fireEvent.click(screen.getByRole('button',{name:'保存历史包'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());
 expect(m).toHaveBeenCalledWith('/finance/fee-archive/snapshots',{method:'POST',body:{name:'修改前',remark:'合成调整原因'}});
});
it('历史表入口保存也用同一内窗，取消不写快照',async()=>{
 m.mockResolvedValue([] as never);render(<FeeSnapshotsDialog embedded canWrite canDelete onClose={vi.fn()} onRestored={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'存为历史包'}));await screen.findByRole('dialog',{name:'保存费用档案历史包'});fireEvent.click(screen.getByRole('button',{name:'取消'}));
 expect(screen.queryByRole('dialog',{name:'保存费用档案历史包'})).toBeNull();expect(m.mock.calls.some(([,opts])=>opts?.method==='POST')).toBe(false);
});
it('原版查看用独立预览窗口，完整内容按12条分页；恢复和删除先开原版确认窗，失败仍可重试',async()=>{
 const snap={id:3,name:'合成历史包',remark:'合成说明',createdAt:'2026-10-24 10:00:00',categoryCount:1,itemCount:13};let fail=true;
 m.mockImplementation(async(path,opts)=>{if(path.endsWith('/restore')){if(fail)throw new Error('offline');return{restored:13,stopped:0} as never;}if(path.endsWith('/3'))return{...snap,items:Array.from({length:13},(_,index)=>({code:`FY-${index}`,name:`合成费用${index}`,category:'合成分类',defaultObject:['公司','店铺'],relationRequirement:'合成节点说明'}))} as never;return[snap] as never;});
 const restored=vi.fn();render(<FeeSnapshotsDialog embedded canWrite canDelete onClose={vi.fn()} onRestored={restored}/>);await screen.findByText('合成历史包');fireEvent.click(screen.getByRole('button',{name:'查看'}));
 const preview=await screen.findByRole('dialog',{name:'合成历史包'});expect(preview.textContent).toContain('公司、店铺');expect(preview.textContent).toContain('合成节点说明');expect(screen.queryByText('合成费用12')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'末页'}));await screen.findByText('合成费用12');fireEvent.click(screen.getByRole('button',{name:'首页'}));await screen.findByText('合成费用0');fireEvent.click(screen.getByRole('button',{name:'关闭'}));
 fireEvent.click(screen.getByRole('button',{name:'恢复'}));await screen.findByRole('dialog',{name:'确认恢复历史包'});expect(m.mock.calls.some(([path])=>path.endsWith('/restore'))).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'确认恢复'}));await screen.findByText('操作失败，请重试');expect(restored).not.toHaveBeenCalled();fail=false;fireEvent.click(screen.getByRole('button',{name:'确认恢复'}));await waitFor(()=>expect(restored).toHaveBeenCalledOnce());
 fireEvent.click(screen.getByRole('button',{name:'删除'}));await screen.findByRole('dialog',{name:'删除历史包'});fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(m.mock.calls.some(([,opts])=>opts?.method==='DELETE')).toBe(false);
});
