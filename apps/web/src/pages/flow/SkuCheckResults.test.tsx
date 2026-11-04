import {useState} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {SkuCheckResults,type SkuCheckEntry} from './SkuCheckResults';
import type {SkuPreviewDto} from './SkuApply';
afterEach(cleanup);
const result:SkuPreviewDto={runId:8,status:'draft',batchName:'申请',scenario:'标准',platforms:[],warehouseDone:false,canCost:false,planError:'',costNote:'',generatedDuplicates:[{id:17,code:'EXISTING-SKU',name:'已有苹果'}],duplicateToken:'a'.repeat(64),specs:[{name:'苹果',note:'',reuseReason:'',weightG:500,totalCost:999999,lines:[],warehouse:[],notRequired:{},targets:[],created:[]}]};
it('原二次确认必须先填原因，修改原因重置勾选，返回同一真实token且无成本权不显示金额',()=>{
 const changed=vi.fn();function Page(){const [entries,setEntries]=useState<Record<number,SkuCheckEntry>>({8:{revision:1,result}});return <SkuCheckResults entries={entries} names={{8:'苹果'}} busy={false} onConfirmation={(id,confirmation)=>{changed(id,confirmation);setEntries(current=>({...current,[id]:{...current[id],confirmation}}));}}/>;}render(<Page/>);
 const checkbox=screen.getByRole('checkbox',{name:'已核对已有 SKU，确认继续申请'});expect((checkbox as HTMLInputElement).disabled).toBe(true);expect(screen.queryByText(/9999/)).toBeNull();fireEvent.change(screen.getByLabelText('明细 8 继续申请原因'),{target:{value:'包装方案不同，已核对继续申请'}});expect((checkbox as HTMLInputElement).disabled).toBe(false);fireEvent.click(checkbox);expect(changed).toHaveBeenLastCalledWith(8,{token:'a'.repeat(64),confirmed:true,reason:'包装方案不同，已核对继续申请'});fireEvent.change(screen.getByLabelText('明细 8 继续申请原因'),{target:{value:'修改后的真实原因'}});expect((checkbox as HTMLInputElement).checked).toBe(false);
});
