import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import {api} from '../api/client';
import {PackagingExcelDialog} from './PackagingExcelDialog';
vi.mock('../api/client',async original=>({...await original<typeof import('../api/client')>(),api:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('真实三工作表XLSX数值单元格保留六位数量、损耗和重量送入统一预检',async()=>{
 const headers=[['方案编码','方案名称','使用场景','商品分类','品牌','生效日期','失效日期','状态','来源类型','来源说明','备注'],['方案编码','包装档案编号','角色','数量','单位','损耗率','成本归类','计价处理','来源行','排序','备注'],['方案编码','目标类型','目标编码','商品分类','品牌','销售场景','最小重量kg','最大重量kg','离散重量kg','优先级','状态','备注']];
 const source:Array<Record<string,string|number>>=[{'方案编码':'SIX-XL','方案名称':'合成六位工作簿','使用场景':'发货包装','状态':'启用'},{'方案编码':'SIX-XL','包装档案编号':'BZ-HC','角色':'包装','数量':1.123456,'损耗率':0.123456},{'方案编码':'SIX-XL','目标类型':'商品组合编码','目标编码':'HC-1','最小重量kg':1.123456,'最大重量kg':1.123457,'优先级':0}];
 const tables=headers.map((head,index)=>[head,head.map(key=>source[index][key]??'')]);
 const workbook=await writeXlsxFile(tables.map(table=>table.map(row=>row.map(value=>typeof value==='number'?{value,type:Number}:{value,type:String}))),{sheets:['包装方案','包装方案明细','匹配规则'],buffer:true});
 const file=new File([new Uint8Array(workbook)],'合成六位.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
 // jsdom缺少现代浏览器File.arrayBuffer；提供同一真实工作簿字节，不替换解析器。
 Object.defineProperty(file,'arrayBuffer',{value:async()=>new Uint8Array(workbook).buffer});
 vi.mocked(api).mockResolvedValue({errors:[],warnings:[],summary:{schemesCreated:1,schemesUpdated:0,lines:1,rules:1},confirm:'IMPORT-PACKAGING-SIX'});
 render(<PackagingExcelDialog canCreate onClose={()=>{}} onDone={()=>{}}/>);fireEvent.change(screen.getByLabelText('选择包装方案文件'),{target:{files:[file]}});
 await screen.findByText(/预检：新建方案 1/);await waitFor(()=>expect(api).toHaveBeenCalledWith('/finance/packaging/import/preflight',expect.objectContaining({body:expect.objectContaining({lines:[expect.objectContaining({'数量':'1.123456','损耗率':'0.123456'})],rules:[expect.objectContaining({'最小重量kg':'1.123456','最大重量kg':'1.123457'})]})})));
});
