import {beforeEach,expect,it,vi} from 'vitest';
import readXlsxFile,{readSheetNames} from 'read-excel-file';
import writeXlsxFile from 'write-excel-file';
import {downloadWorkbook,readXlsxWorkbook} from './xlsx';
vi.mock('read-excel-file',()=>({default:vi.fn(),readSheetNames:vi.fn()}));vi.mock('write-excel-file',()=>({default:vi.fn()}));
beforeEach(()=>{vi.resetAllMocks();});
it('全部工作表按名称读取，文字编码/空行/日期保持原行位置，说明不参与资料行',async()=>{
 vi.mocked(readSheetNames).mockResolvedValue(['主档','明细','说明']);vi.mocked(readXlsxFile).mockImplementation((async(_file:unknown,options?:{sheet?:string|number})=>options?.sheet==='主档'?[['编码','名称','日期'],['00001','合成甲',new Date('2026-10-24T00:00:00Z')],[],['00002','合成乙']]:[['主档编码','数量'],['00001',2]]) as never);
 const book=await readXlsxWorkbook(new File(['synthetic'],'合成.xlsx'));expect(book).toEqual([{name:'主档',headers:['编码','名称','日期'],rows:[{编码:'00001',名称:'合成甲',日期:'2026-10-24'},{编码:'',名称:'',日期:''},{编码:'00002',名称:'合成乙',日期:''}]},{name:'明细',headers:['主档编码','数量'],rows:[{主档编码:'00001',数量:'2'}]},{name:'说明',headers:[],rows:[]}]);expect(readXlsxFile).toHaveBeenCalledTimes(2);
});
it('重复表头及无表头的非空单元格不能被悄悄覆盖或丢掉',async()=>{
 vi.mocked(readSheetNames).mockResolvedValue(['主档']);vi.mocked(readXlsxFile).mockResolvedValueOnce([['编码','编码'],['1','2']] as never);await expect(readXlsxWorkbook(new File([],'合成.xlsx'))).rejects.toThrow(/重复表头/);
 vi.mocked(readXlsxFile).mockResolvedValueOnce([['编码',''],['1','合成未命名数据']] as never);await expect(readXlsxWorkbook(new File([],'合成.xlsx'))).rejects.toThrow(/第2行第2列缺少表头/);
});
it('多表下载全部单元格按文字写，不把前导零编码转成数字',async()=>{
 vi.mocked(writeXlsxFile).mockResolvedValue(new Blob(['synthetic']) as never);const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});const create=vi.fn().mockReturnValue('blob:synthetic'),revoke=vi.fn();vi.stubGlobal('URL',class extends URL{static createObjectURL=create;static revokeObjectURL=revoke;});
 await downloadWorkbook('合成.xlsx',[{name:'主档',rows:[['编码'],['00001']]},{name:'明细',rows:[['主档编码'],['00001']]}]);expect(writeXlsxFile).toHaveBeenCalledWith([[[{type:String,value:'编码',fontWeight:'bold'}],[{type:String,value:'00001'}]],[[{type:String,value:'主档编码',fontWeight:'bold'}],[{type:String,value:'00001'}]]],{sheets:['主档','明细']});expect(click).toHaveBeenCalledOnce();expect(revoke).toHaveBeenCalledWith('blob:synthetic');click.mockRestore();vi.unstubAllGlobals();
});
