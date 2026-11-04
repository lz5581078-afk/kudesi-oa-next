import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {BundleReferenceDetail} from './BundleReferenceDetail';
import {jstApi,type BundleComposition,type BundleReferenceDetail as Detail} from './jstApi';
vi.mock('./jstApi',()=>({jstApi:{bundleComposition:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const detail:Detail={id:1,code:'ZH-DETAIL',name:'真实合成组合',shortName:'合成简称',styleCode:'STYLE',mainStyleCode:'MAIN',platform:'平台',spec:'1千克',costVersionName:'实际锁定版',lines:[{id:11,role:'main',name:'成品别名',code:'RAW-ALIAS',spec:'1千克',qty:2,unit:'KG',weightG:2000,isRawFinishedName:true,cost:123.4567,costSubtotal:246.9134,costSource:'SKU成本快照',saleSubtotal:1000},{id:12,role:'gift',name:'真实赠品',code:'GIFT',spec:'',qty:1,unit:'',weightG:null,isRawFinishedName:false,costSubtotal:null,costSource:'基础编码未维护有效成本',saleSubtotal:0},{id:13,role:'labor',name:'装箱人工',code:'LABOR',spec:'',qty:2,unit:'次',weightG:null,isRawFinishedName:false,costSubtotal:20}]};
const result=(d=detail)=>({referenceDetail:d} as BundleComposition);
describe('组合专用只读详情',()=>{
 it('分组与五卡取真实GET；保快照精度/缺失事实，不用当前价填补，修改回调复用宿主',async()=>{
  vi.mocked(jstApi.bundleComposition).mockResolvedValue(result());const onEdit=vi.fn(),onComposition=vi.fn(),onClose=vi.fn();render(<BundleReferenceDetail id={1} onClose={onClose} onEdit={onEdit} onComposition={onComposition}/>);
  await screen.findByText('成品别名');expect(screen.getByText('¥2.469134')).toBeTruthy();expect(screen.getByText('SKU成本快照')).toBeTruthy();expect(screen.getByText('2.000000 kg')).toBeTruthy();expect(screen.getByText('当前BOM未维护包装组成。').className).toBe('bundle-reference-package-empty');expect(screen.getByRole('table',{name:'主商品'}).querySelector('.bundle-reference-detail-line')?.getAttribute('style')).toContain('minmax(280px,2fr) 120px 80px 120px 120px 140px');expect(screen.getByText('SKU成本快照').parentElement?.tagName).toBe('SPAN');expect(screen.getByText('装箱人工')).toBeTruthy();expect(screen.getByText('成本：实际锁定版')).toBeTruthy();expect(screen.getAllByText('未维护').length).toBeGreaterThan(0);expect(screen.getByText('¥0.000')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'修改'}));fireEvent.click(screen.getByRole('button',{name:'修改组成'}));expect(onEdit).toHaveBeenCalledOnce();expect(onComposition).toHaveBeenCalledOnce();
 });
 it('成本显示保留八位元而售价按源独立三位元终点，缺失仍未维护',async()=>{
  vi.mocked(jstApi.bundleComposition).mockResolvedValue(result({...detail,lines:[{...detail.lines[0],costSubtotal:12.345678,saleSubtotal:12.345678},{...detail.lines[1],costSubtotal:0.000001,saleSubtotal:null}]}));render(<BundleReferenceDetail id={1} onClose={()=>{}}/>);await screen.findByText('¥0.12345678');expect(screen.getByText('¥0.00000001')).toBeTruthy();expect(screen.getByText('¥0.123')).toBeTruthy();expect(screen.getAllByText('未维护').length).toBeGreaterThan(0);
 });
 it('缺失projection失败明确可重试；ACL未返回金额时不渲染金额列/版本，保留文本和重量',async()=>{
  const hidden={...detail,costVersionName:undefined,lines:detail.lines.map(({cost,costSubtotal,costSource,saleSubtotal,...line})=>line)};
  vi.mocked(jstApi.bundleComposition).mockResolvedValueOnce({} as BundleComposition).mockResolvedValueOnce(result(hidden));render(<BundleReferenceDetail id={1} onClose={()=>{}}/>);await screen.findByRole('alert');expect(screen.queryByText('成品别名')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByText('成品别名');expect(screen.queryByText('成本小计')).toBeNull();expect(screen.queryByText('销售小计')).toBeNull();expect(screen.queryByText(/成本：/)).toBeNull();expect(screen.queryByRole('button',{name:'修改'})).toBeNull();
 });
 it('身份宿主卸载或切换ID后，旧GET迟到不覆盖新详情',async()=>{
  let resolve!:(value:BundleComposition)=>void;vi.mocked(jstApi.bundleComposition).mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValueOnce(result({...detail,id:2,name:'新详情'}));const view=render(<BundleReferenceDetail id={1} onClose={()=>{}}/>);view.rerender(<BundleReferenceDetail id={2} onClose={()=>{}}/>);await screen.findByText('新详情');resolve(result());await waitFor(()=>expect(screen.queryByText('真实合成组合')).toBeNull());expect(screen.getByText('新详情')).toBeTruthy();
 });
});
