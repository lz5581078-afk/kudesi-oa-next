import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {BundleCompositionEditorView,type CompositionFact,type CompositionLine} from './BundleCompositionEditorView';
import type {ResourceDto} from '../../../resources/api';
const bundle:ResourceDto={id:7,type:'finance-bundles',title:'合成组合',status:'reverify',statusReason:null,data:{code:'ZH-HC',name:'合成组合',bomVersion:'V01'},refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''};
const lines:CompositionLine[]=[{role:'main',baseCodeId:11,label:'原主品',qty:1,includeInJst:true},{role:'gift',baseCodeId:12,label:'锁定赠品',qty:2,includeInJst:true},{role:'package',productId:13,label:'原直接包装',qty:2.5,includeInJst:true}];
const facts:Record<string,CompositionFact>={'base:11':{title:'原主品',code:'HC-1',unit:'千克',weightG:1000,available:true},'base:12':{title:'锁定赠品',code:'HC-G',unit:'个',weightG:100,available:true},'archive:13':{title:'原直接包装',code:'BZ-1',unit:'张',weightG:10,available:true}};
afterEach(cleanup);
const props={bundle,initialLines:lines,facts,originalWeightG:1225,weightMode:'auto' as const,canManualWeight:true,busy:false,error:'',history:[],onPick:vi.fn(),onClose:vi.fn(),onSave:vi.fn(),onVerify:vi.fn(),onCancel:vi.fn()};
it('赠品锁定、材料/人工分区与重量事实，直接档案上传原true保留且不得勾改',()=>{
 const save=vi.fn();render(<BundleCompositionEditorView {...props} onSave={save}/>);
 expect(screen.getByText('保持原SKU')).toBeTruthy();expect(screen.queryByLabelText('第2项数量')).toBeNull();expect((screen.getByLabelText('第3项计入聚水潭上传组成') as HTMLInputElement).checked).toBe(true);expect((screen.getByLabelText('第3项计入聚水潭上传组成') as HTMLInputElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('确认组合总重量'),{target:{value:'1.234567'}});fireEvent.change(screen.getByLabelText('组成修改原因'),{target:{value:'精确修正包装重量'}});fireEvent.click(screen.getByRole('button',{name:'保存新版本并核对'}));expect(save).toHaveBeenCalledWith(expect.objectContaining({weightMode:'manual',manualWeightG:1234.567,lines:expect.arrayContaining([expect.objectContaining({productId:13,includeInJst:true}),expect.objectContaining({baseCodeId:12,qty:2,role:'gift'})])}));
});
it('旧修订无重量事实时明确未记录，不用原重量伪造该修订历史',()=>{render(<BundleCompositionEditorView {...props} pending={{id:9,reason:'原无重量修订',lines}}/>);expect(screen.getByText('本修订未记录重量')).toBeTruthy();expect(screen.queryByLabelText('确认组合总重量')).toBeNull();expect(screen.getByRole('button',{name:/查看差异并验证新版本/})).toBeTruthy();});
it('新增材料仅显示原五种用途，已存辅助材料值仍可辨认保留',()=>{
 const rendered=render(<BundleCompositionEditorView {...props}/>);expect(Array.from((screen.getByLabelText('第1项角色') as HTMLSelectElement).options).map(option=>option.value)).toEqual(['main','package','label','instruction','other']);
  rendered.unmount();render(<BundleCompositionEditorView {...props} initialLines={[{role:'auxiliary',productId:13,qty:1,label:'原辅助材料'}]}/>);expect((screen.getByLabelText('第1项角色') as HTMLSelectElement).value).toBe('auxiliary');expect(screen.getByRole('option',{name:'辅助材料'})).toBeTruthy();
});
it('未选择blank材料仅在预览贡献0，主品数量仍自动联动，但保存必须先选完整来源',()=>{
 const save=vi.fn();render(<BundleCompositionEditorView {...props} initialLines={[lines[0]]} originalWeightG={1000} onSave={save}/>);fireEvent.change(screen.getByLabelText('组成修改原因'),{target:{value:'合成新增待选择材料'}});fireEvent.click(screen.getByRole('button',{name:'添加组成'}));fireEvent.change(screen.getByLabelText('第1项数量'),{target:{value:'2'}});expect((screen.getByLabelText('确认组合总重量') as HTMLInputElement).value).toBe('2');expect(screen.queryByText('有待核对组成，暂保留原总重量')).toBeNull();expect((screen.getByRole('button',{name:'保存新版本并核对'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:'保存新版本并核对'}));expect(save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'删除第2项'}));expect((screen.getByRole('button',{name:'保存新版本并核对'}) as HTMLButtonElement).disabled).toBe(false);
});
it('已有来源ID缺重量事实时保护旧重量并在右侧提示，不把未知当0',()=>{
 render(<BundleCompositionEditorView {...props} initialLines={[lines[0]]} originalWeightG={1234} facts={{'base:11':{...facts['base:11'],weightG:null}}}/>);fireEvent.change(screen.getByLabelText('第1项数量'),{target:{value:'3'}});expect((screen.getByLabelText('确认组合总重量') as HTMLInputElement).value).toBe('1.234');expect(screen.getByText('有待核对组成，暂保留原总重量').closest('aside')).toBeTruthy();
});
it('人工独立编号从1开始，材料备注2000字完整保留到保存',()=>{
 const save=vi.fn();render(<BundleCompositionEditorView {...props} initialLines={[lines[0],{role:'labor',laborId:90,label:'合成人工',qty:1}]} onSave={save}/>);expect(screen.getByRole('button',{name:'按分类选择第1项人工'})).toBeTruthy();expect(screen.getByLabelText('第1项人工数量')).toBeTruthy();expect(screen.queryByLabelText('第2项人工数量')).toBeNull();const note=screen.getByLabelText('第1项备注') as HTMLInputElement;expect(note.maxLength).toBe(2000);fireEvent.change(note,{target:{value:'备注'.repeat(1000)}});fireEvent.change(screen.getByLabelText('组成修改原因'),{target:{value:'保留完整原有备注'}});fireEvent.click(screen.getByRole('button',{name:'保存新版本并核对'}));expect(save).toHaveBeenCalledWith(expect.objectContaining({lines:expect.arrayContaining([expect.objectContaining({note:'备注'.repeat(1000)})])}));
});
it('失效来源可定位具体组成行，保存失败保留原业务说明',()=>{
 const change=vi.fn();render(<BundleCompositionEditorView {...props} initialLines={[lines[0]]} facts={{'base:11':{...facts['base:11'],available:false}}} error="来源已停用，请重新选择" onChange={change}/>);const row=screen.getByRole('button',{name:'按分类选择第1项商品或材料'}).closest('article')!,scroll=vi.fn();row.scrollIntoView=scroll;fireEvent.click(screen.getByRole('button',{name:'定位待核对项'}));expect(scroll).toHaveBeenCalledWith({block:'center',behavior:'smooth'});expect(row.classList.contains('needs-attention')).toBe(true);expect(screen.getByText('保存未完成')).toBeTruthy();expect(screen.getByText('本次尚未更新当前组成和成本。检查下方标记项目后，再保存新版本。')).toBeTruthy();fireEvent.change(screen.getByLabelText('第1项数量'),{target:{value:'2'}});expect(change).toHaveBeenCalledOnce();
});
