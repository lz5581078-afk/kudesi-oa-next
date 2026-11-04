import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CheckoutFeedbackFields,CheckoutFeedbackRecords} from './CheckoutFeedback';
import {CheckOutDialog} from './CheckOutDialog';
import {liveApi,type FeedbackDraft} from './liveApi';
vi.mock('./liveApi',()=>({liveApi:{checkoutFeedback:vi.fn(),uploadFeedbackImage:vi.fn(),feedbackImageUrl:vi.fn(),checkoutPreview:vi.fn(),report:vi.fn()}}));
const a=vi.mocked(liveApi),file={id:8,name:'本场数据.png',mime:'image/png',size:8},targets=[{userId:1,name:'主播甲',role:'anchor'},{userId:3,name:'运营乙',role:'operator'}];
beforeEach(()=>{vi.resetAllMocks();a.checkoutFeedback.mockResolvedValue({targets,records:[],locked:false});a.uploadFeedbackImage.mockResolvedValue(file);a.feedbackImageUrl.mockResolvedValue({url:'data:image/png;base64,'});});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('打开审核图片使用大图预览并刷新原图地址，避免复用过期的缩略图链接',async()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
 a.feedbackImageUrl.mockResolvedValueOnce({url:'/earlier.png'}).mockResolvedValue({url:'/fresh-original.png'});
 const view=render(<CheckoutFeedbackRecords sessionId={7} records={[{reporterId:2,reporterName:'中控丙',role:'control',submittedAt:'2026-11-03 11:50:00',images:[file],ratings:[]}]}/>);
 const button=screen.getByRole('button',{name:'查看本场数据.png'});
 await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));fireEvent.click(button);
 const dialog=screen.getByRole('dialog',{name:'直播数据图片'});
 await waitFor(()=>expect(within(dialog).getByRole('link',{name:'查看原图'}).getAttribute('href')).toBe('/fresh-original.png'));
 expect(within(dialog).getByLabelText('图片缩放比例').textContent).toBe('100%');
 view.unmount();vi.unstubAllGlobals();
});
it('中控必须先上传图片并逐人评分；0分有效，滑杆满分10分，上传失败不能提交',async()=>{
 const drafts:FeedbackDraft[]=[];render(<CheckoutFeedbackFields sessionId={7} role="control" onChange={d=>drafts.push(d)}/>);
 await screen.findByRole('slider',{name:'给主播甲评分'});expect(drafts.at(-1)?.ready).toBe(false);expect(screen.getAllByText('未评分')).toHaveLength(2);
 fireEvent.change(screen.getByRole('slider',{name:'给主播甲评分'}),{target:{value:'0'}});fireEvent.change(screen.getByRole('slider',{name:'给运营乙评分'}),{target:{value:'10'}});expect(drafts.at(-1)?.ready).toBe(false);
 fireEvent.change(screen.getByLabelText('上传直播数据图片'),{target:{files:[new File(['data'],'本场数据.png',{type:'image/png'})]}});
 await screen.findByText('本场数据.png');await waitFor(()=>expect(drafts.at(-1)).toMatchObject({ready:true,evidenceFileIds:[8],ratings:[{userId:1,score:0},{userId:3,score:10}]}));
 fireEvent.click(screen.getByRole('button',{name:'移除本场数据.png'}));await waitFor(()=>expect(drafts.at(-1)?.ready).toBe(false));
 a.uploadFeedbackImage.mockRejectedValue(new Error('网络失败'));fireEvent.change(screen.getByLabelText('上传直播数据图片'),{target:{files:[new File(['data'],'再次上传.png',{type:'image/png'})]}});await screen.findByRole('alert');expect(drafts.at(-1)?.ready).toBe(false);
});
it('主播不需要图片；没有其他实际参与人员时可正常确认',async()=>{
 a.checkoutFeedback.mockResolvedValue({targets:[],records:[],locked:false});let latest:FeedbackDraft|undefined;
 render(<CheckoutFeedbackFields sessionId={7} role="anchor" onChange={d=>{latest=d;}}/>);await screen.findByText('本场没有需要你评分的其他人员。');expect(screen.queryByLabelText('上传直播数据图片')).toBeNull();await waitFor(()=>expect(latest?.ready).toBe(true));
});
it('审核和详情保留提交人、原始上下播、图片及0分和10分记录',async()=>{
 render(<CheckoutFeedbackRecords sessionId={7} attendance={[{userId:2,name:'中控丙',role:'control',startAt:'2026-11-03 10:00:00',endAt:'2026-11-03 11:50:00'}]} records={[{reporterId:2,reporterName:'中控丙',role:'control',submittedAt:'2026-11-03 11:50:00',images:[file],ratings:[{...targets[0],score:0},{...targets[1],score:10}]}]}/>);
 expect(screen.getByRole('table',{name:'本人原始上下播记录'})).toBeTruthy();expect(screen.getByText('0 / 10')).toBeTruthy();expect(screen.getByText('10 / 10')).toBeTruthy();await screen.findByRole('button',{name:'查看本场数据.png'});expect(a.feedbackImageUrl).toHaveBeenCalledWith(7,8);
});
it('下播按钮在资料未完成时禁用，完成后提交图片ID和实际评分',async()=>{
 a.checkoutFeedback.mockResolvedValue({targets:[targets[0]],records:[],locked:false});a.checkoutPreview.mockResolvedValue({role:'control',startAt:'2026-11-03 10:00:00',endAt:'2026-11-03 11:00:00',minutes:60,salesCents:0,orderCount:0,reason:'',wage:null,commission:null,locked:false});a.report.mockResolvedValue({ok:true});
 render(<CheckOutDialog session={{id:7,roomName:'北1',anchor:{id:1,name:'主播甲'},control:{id:2,name:'中控丙'},channels:[],me:{reportRoles:['control']}} as never} onClose={()=>{}} onDone={()=>{}}/>);
 const button=await screen.findByRole('button',{name:'确认下播'});expect((button as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(await screen.findByRole('slider',{name:'给主播甲评分'}),{target:{value:'8'}});fireEvent.change(screen.getByLabelText('上传直播数据图片'),{target:{files:[new File(['data'],'本场数据.png',{type:'image/png'})]}});fireEvent.click(screen.getByRole('checkbox',{name:'已核对本场投流费用'}));
 await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));fireEvent.click(button);await waitFor(()=>expect(a.report).toHaveBeenCalledWith(7,expect.objectContaining({evidenceFileIds:[8],ratings:[{userId:1,score:8}],role:'control'})));
});
