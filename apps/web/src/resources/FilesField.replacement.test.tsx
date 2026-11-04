import{cleanup,fireEvent,render,screen,waitFor}from'@testing-library/react';
import{afterEach,beforeEach,expect,it,vi}from'vitest';
import{getResourceDef}from'@kudesi/shared';
const mocks=vi.hoisted(()=>({upload:vi.fn()}));
vi.mock('./api',()=>({resourceApi:{uploadFile:(...args:unknown[])=>mocks.upload(...args),fileUrl:vi.fn(async()=>({url:'data:image/png;base64,AA=='}))}}));
import{FilesInput}from'./FilesField';
const field=getResourceDef('finance-suppliers')!.fields.find(field=>field.key==='paymentQr')!;
const old={id:1,name:'旧收款码.png',mime:'image/png',size:20};
beforeEach(()=>{mocks.upload.mockReset();});afterEach(cleanup);
it('单图选择，原上传/替换/删除控件，不提供PDF或手机入口，旧ID到新图成功才替换',async()=>{
 const change=vi.fn(),known=vi.fn();mocks.upload.mockResolvedValue({id:2,name:'新图.png',mime:'image/png',size:10});
 render(<FilesInput field={field} type="finance-suppliers" value={[1]} known={{1:old}} onChange={change} onKnown={known}/>);
 const input=screen.getByLabelText('上传收款码')as HTMLInputElement;expect(input.multiple).toBe(false);expect(input.accept).not.toContain('pdf');expect(screen.queryByText('手机上传')).toBeNull();expect(screen.getByRole('button',{name:'更换收款码'})).toBeTruthy();expect(screen.getByRole('button',{name:'移除 旧收款码.png'}).textContent).toBe('删除');
 fireEvent.change(input,{target:{files:[new File(['image'],'新图.png',{type:'image/png'})]}});
 await waitFor(()=>expect(change).toHaveBeenCalledWith([2]));expect(change).not.toHaveBeenCalledWith([]);expect(known).toHaveBeenCalledWith(expect.objectContaining({id:2}));
});
it('超大/非图片/多选/服务器失败保留原两张历史附件，不先清空原ID',async()=>{
 const change=vi.fn();render(<FilesInput field={field} type="finance-suppliers" value={[1,3]} known={{1:old,3:{...old,id:3,name:'历史PDF.pdf',mime:'application/pdf'}}} onChange={change} onKnown={()=>undefined}/>);
 const input=screen.getByLabelText('上传收款码');fireEvent.change(input,{target:{files:[new File([new Uint8Array(2*1024*1024+1)],'大图.png',{type:'image/png'})]}});expect((await screen.findByRole('alert')).textContent).toContain('超过 2 MB');
 fireEvent.change(input,{target:{files:[new File(['pdf'],'伪图.png',{type:'application/pdf'})]}});expect(await screen.findByText('只能上传图片')).toBeTruthy();
 fireEvent.change(input,{target:{files:[new File(['1'],'1.png',{type:'image/png'}),new File(['2'],'2.png',{type:'image/png'})]}});expect(await screen.findByText('每次请选择一张图片')).toBeTruthy();expect(mocks.upload).not.toHaveBeenCalled();
 mocks.upload.mockRejectedValue(new Error('合成失败'));fireEvent.change(input,{target:{files:[new File(['1'],'1.png',{type:'image/png'})]}});expect(await screen.findByText(/上传失败/)).toBeTruthy();expect(change).not.toHaveBeenCalled();expect(screen.getByText('历史PDF.pdf')).toBeTruthy();
});

it('原收款码空态展示尚未上传与图标，不重复通用文件上限提示',()=>{
 render(<FilesInput field={field} type="finance-suppliers" value={[]} known={{}} onChange={()=>undefined} onKnown={()=>undefined}/>);
 expect(screen.getByText('尚未上传')).toBeTruthy();expect(document.querySelector('.replacement-file-empty svg')).toBeTruthy();expect(screen.getByRole('button',{name:'上传收款码'})).toBeTruthy();expect(screen.queryByText(/单个文件不超过/)).toBeNull();
});
