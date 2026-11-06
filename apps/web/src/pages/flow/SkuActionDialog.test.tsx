import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {SkuActionDialog} from './SkuActionDialog';
afterEach(()=>{cleanup();});
it('原财务确认只有统一审核确认并自动同步，备注最多500字',()=>{
 const send=vi.fn(async()=>undefined);render(<SkuActionDialog action="approve" count={2} busy={false} onClose={()=>undefined} onConfirm={send}/>);
 const button=screen.getByRole('button',{name:'审核并更新成本表'});expect(button.hasAttribute('disabled')).toBe(true);expect(screen.getAllByRole('checkbox')).toHaveLength(1);fireEvent.change(screen.getByLabelText('备注'),{target:{value:'实际审核意见'}});expect(screen.getByLabelText('备注').getAttribute('maxlength')).toBe('500');fireEvent.click(screen.getByRole('checkbox',{name:'已核对所选规格、发货组成和成本，确认更新成本表并同步聚水潭'}));fireEvent.click(button);expect(send).toHaveBeenCalledWith('实际审核意见');
});
it('原废除/拒绝需非空原因，busy时禁用提交与关闭；失败重渲染保留所填意见',()=>{
 const send=vi.fn(async()=>undefined),close=vi.fn();const props={action:'reject' as const,count:1,busy:false,onClose:close,onConfirm:send};const {rerender}=render(<SkuActionDialog {...props}/>);const confirm=screen.getByRole('button',{name:'确认'});fireEvent.click(confirm);expect(send).not.toHaveBeenCalled();fireEvent.change(screen.getByLabelText('原因（必填）'),{target:{value:'不通过的真实原因'}});rerender(<SkuActionDialog {...props} busy/>);expect(confirm.hasAttribute('disabled')).toBe(true);expect(screen.getByRole('button',{name:'关闭动作确认'}).hasAttribute('disabled')).toBe(true);rerender(<SkuActionDialog {...props}/>);expect((screen.getByLabelText('原因（必填）') as HTMLTextAreaElement).value).toBe('不通过的真实原因');fireEvent.click(confirm);expect(send).toHaveBeenCalledWith('不通过的真实原因');
});

it('旧单审核的聚水潭同步由有权限的财务人员明确勾选', () => {
 const send=vi.fn(async()=>undefined);
 render(<SkuActionDialog action="approve" count={1} busy={false} syncMode="optional" onClose={()=>undefined} onConfirm={send}/>);
 const submit=screen.getByRole('button',{name:'审核并更新成本表'});
 const sync=screen.getByRole('checkbox',{name:'通过后加入聚水潭同步队列'});
 expect((sync as HTMLInputElement).checked).toBe(false);
 fireEvent.click(screen.getByRole('checkbox',{name:'已核对所选规格、发货组成和成本，确认更新成本表'}));
 fireEvent.click(submit);
 expect(send).toHaveBeenLastCalledWith('',false);
 fireEvent.click(sync);
 fireEvent.click(submit);
 expect(send).toHaveBeenLastCalledWith('',true);
});
