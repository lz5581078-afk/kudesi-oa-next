import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ResourceImportProfile} from '@kudesi/shared';
import {ProfileImportPanel} from './ProfileImportPanel';
import {resourceApi} from './api';
import {downloadWorkbook,readXlsxWorkbook} from './xlsx';
vi.mock('./api',()=>({resourceApi:{importProfile:vi.fn()}}));vi.mock('./xlsx',()=>({readXlsxWorkbook:vi.fn(),downloadWorkbook:vi.fn()}));
const profile:ResourceImportProfile={id:'synthetic',label:'合成模块',maxRows:5000,sheets:[{name:'主档',headers:['编码','名称'],examples:[{编码:'00001',名称:'合成主档'}]},{name:'明细',headers:['主档编码','数量'],examples:[{主档编码:'00001',数量:'2'}]}],steps:[{id:'main',sheet:'主档',resource:'finance-platforms',fields:{}}]};
const book=[{name:'主档',headers:['编码','名称'],rows:[{编码:'00001',名称:'合成主档'}]},{name:'明细',headers:['主档编码','数量'],rows:[{主档编码:'00001',数量:'2'}]}];
const preview={dryRun:true,committed:false,created:1,updated:0,failed:0,results:[{sheet:'主档',step:'main',line:2,action:'create',title:'合成主档',errors:[]}],issues:[],signature:'合成预检签名'};
const show=(onDone=vi.fn())=><ProfileImportPanel profile={profile} headerControl={<label>导入类型<select aria-label="导入类型"><option>合成模块</option></select></label>} onDone={onDone}/>;
const choose=()=>fireEvent.change(screen.getByLabelText('选择 Excel 并预检'),{target:{files:[new File(['synthetic'],'合成工作簿.xlsx')]}});
beforeEach(()=>{vi.resetAllMocks();vi.mocked(readXlsxWorkbook).mockResolvedValue(book);vi.mocked(resourceApi.importProfile).mockResolvedValue(preview);});afterEach(cleanup);
it('多表原值预检，签名未错位，重复点击只提交一次，成功清空本次文件',async()=>{
 const done=vi.fn();render(show(done));choose();await screen.findByText('数据 1 条');expect(resourceApi.importProfile).toHaveBeenCalledWith('synthetic',book,true);
 let finish!:(value:never)=>void;vi.mocked(resourceApi.importProfile).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));fireEvent.click(screen.getByRole('button',{name:'确认导入本地系统'}));fireEvent.click(screen.getByRole('button',{name:'确认导入本地系统'}));expect(resourceApi.importProfile).toHaveBeenCalledTimes(2);expect(resourceApi.importProfile).toHaveBeenLastCalledWith('synthetic',book,false,'合成预检签名');
 await act(async()=>finish({...preview,dryRun:false,committed:true,created:3,mainCreated:1,mainUpdated:0,detailRows:2} as never));expect(done).toHaveBeenCalledOnce();expect(done).toHaveBeenCalledWith('导入完成：新增 1，更新 0，明细 2。');expect(screen.queryByText('合成工作簿.xlsx')).toBeNull();
});
it('原表名和行错误明确呈现并阻止导入；无签名也不能执行',async()=>{
 vi.mocked(resourceApi.importProfile).mockResolvedValue({...preview,failed:1,signature:undefined,issues:[{sheet:'明细',row:5,field:'主档编码',message:'引用不存在'}]});render(show());choose();await screen.findByText('引用不存在',{exact:false});expect(screen.getByText('明细 第 5 行 · 主档编码')).toBeTruthy();expect((screen.getByRole('button',{name:'确认导入本地系统'}) as HTMLButtonElement).disabled).toBe(true);
});
it('模板与示例都保留全部工作表、文字编码及列顺序',async()=>{
 render(show());fireEvent.click(screen.getByRole('button',{name:'下载示例'}));await waitFor(()=>expect(downloadWorkbook).toHaveBeenCalledWith('合成模块-示例.xlsx',[{name:'主档',rows:[['编码','名称'],['00001','合成主档']]},{name:'明细',rows:[['主档编码','数量'],['00001','2']]}]));
});
it('旧表单的文件读取/预检完成不能回填新类型或执行旧完成回调',async()=>{
 let read!:(value:never)=>void;vi.mocked(readXlsxWorkbook).mockReturnValueOnce(new Promise(resolve=>{read=resolve;}));const first=render(show());choose();first.unmount();await act(async()=>read(book as never));expect(resourceApi.importProfile).not.toHaveBeenCalled();
 let result!:(value:never)=>void;vi.mocked(readXlsxWorkbook).mockResolvedValue(book);vi.mocked(resourceApi.importProfile).mockReturnValueOnce(new Promise(resolve=>{result=resolve;}));const done=vi.fn(),second=render(show(done));choose();await waitFor(()=>expect(resourceApi.importProfile).toHaveBeenCalledOnce());second.unmount();render(show());await act(async()=>result(preview as never));expect(screen.queryByText('数据 1 条')).toBeNull();expect(done).not.toHaveBeenCalled();
});
it('清理资料进行中时不能开始导入；清理结束才恢复文件预检',async()=>{
 const view=render(<ProfileImportPanel profile={profile} headerControl={null} onDone={vi.fn()} blocked/>);
 expect((screen.getByRole('button',{name:'选择 Excel 并预检'}) as HTMLButtonElement).disabled).toBe(true);
 choose();expect(readXlsxWorkbook).not.toHaveBeenCalled();expect(resourceApi.importProfile).not.toHaveBeenCalled();
 view.rerender(<ProfileImportPanel profile={profile} headerControl={null} onDone={vi.fn()} blocked={false}/>);
 choose();await screen.findByText('数据 1 条');expect(resourceApi.importProfile).toHaveBeenCalledOnce();
});
