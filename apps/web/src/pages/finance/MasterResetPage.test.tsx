import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MasterResetPage} from './DataToolPages';
import {financeApi} from './financeApi';
vi.mock('./financeApi',()=>({financeApi:{resetPreview:vi.fn(),snapshots:vi.fn(),resetExecute:vi.fn(),restoreSnapshot:vi.fn()}}));
const api=vi.mocked(financeApi),preview={includePlatforms:true,total:2,tables:[{type:'finance-products',label:'商品档案',count:2}],confirmation:'合成确认',blockedByDocuments:0,blockedByCostVersions:0,exclusions:[]};
beforeEach(()=>{vi.resetAllMocks();api.resetPreview.mockResolvedValue(preview);api.snapshots.mockResolvedValue([]);api.resetExecute.mockResolvedValue({totalDeleted:2,snapshot:{id:9}} as never);});afterEach(cleanup);
it('源内页显式预览才读取，切换范围清掉确认与预览，财务引用阻止执行',async()=>{
  render(<MasterResetPage embedded presentation="master"/>);expect(api.resetPreview).not.toHaveBeenCalled();expect(screen.queryByLabelText('确认文本')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'预览清理范围'}));await screen.findByLabelText('确认文本');fireEvent.change(screen.getByLabelText('确认文本'),{target:{value:'合成确认'}});
  fireEvent.click(screen.getByLabelText('同时清空销售平台'));expect(screen.queryByLabelText('确认文本')).toBeNull();expect(api.resetExecute).not.toHaveBeenCalled();
  api.resetPreview.mockResolvedValue({...preview,blockedByDocuments:1});fireEvent.click(screen.getByRole('button',{name:'预览清理范围'}));await screen.findByLabelText('确认文本');fireEvent.change(screen.getByLabelText('确认文本'),{target:{value:'合成确认'}});expect((screen.getByRole('button',{name:'创建快照并清空'}) as HTMLButtonElement).disabled).toBe(true);expect(api.resetPreview).toHaveBeenLastCalledWith(false);
});
it('旧预览迟到不能回填重开的内页，重复提交只有一次且保留现有确认边界',async()=>{
  let oldResolve!:(value:never)=>void;api.resetPreview.mockReturnValueOnce(new Promise(done=>{oldResolve=done;}));const view=render(<MasterResetPage embedded presentation="master"/>);fireEvent.click(screen.getByRole('button',{name:'预览清理范围'}));view.unmount();render(<MasterResetPage embedded presentation="master"/>);await act(async()=>{oldResolve(preview as never);});expect(screen.queryByLabelText('确认文本')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'预览清理范围'}));await screen.findByLabelText('确认文本');fireEvent.change(screen.getByLabelText('确认文本'),{target:{value:'合成确认'}});
  let finish!:(value:never)=>void;api.resetExecute.mockReturnValueOnce(new Promise(done=>{finish=done;}));fireEvent.click(screen.getByRole('button',{name:'创建快照并清空'}));fireEvent.click(screen.getByRole('button',{name:'创建快照并清空'}));expect(api.resetExecute).toHaveBeenCalledTimes(1);expect(api.resetExecute).toHaveBeenCalledWith({confirm:'合成确认',includePlatforms:true});
  await act(async()=>{finish({totalDeleted:2,snapshot:{id:9}} as never);});await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('可恢复快照 #9'));expect(screen.queryByLabelText('确认文本')).toBeNull();expect(api.resetPreview).toHaveBeenCalledTimes(2);
});
