import type { ResourceDef } from './resources';
import { ref,text,textarea } from './resource-kit';
/** Duplicate registrations remain below one actual phone number. */
export const PHONE_HISTORY_RESOURCE_DEF:ResourceDef={
  key:'phone-registration-history',label:'原号码登记',parent:{type:'phones',field:'phoneId'},readOnly:true,
  titleField:'sourceId',uniqueField:'sourceId',statuses:[{value:'recorded',label:'原登记',tone:'muted'}],defaultStatus:'recorded',
  fields:[
    ref('phoneId','现号码档案','来源','phones',{required:true}),text('sourceId','原登记编号','来源',{required:true,list:true}),
    text('sourceStatus','原状态','来源',{list:true}),
    text('certifiedName','原号码认证人','原登记',{list:true}),text('plan','原套餐','原登记',{list:true}),
    text('externalUser','原外部使用人','原登记'),text('deviceType','原手机类型','原登记'),
    text('forwardApp','原是否有转发程序','原登记'),text('forwardAppName','原转发程序名称','原登记'),
    text('rechargeDay','原固定充值日','原登记'),text('feeCycle','原费用周期','原登记'),
    textarea('originalRemark','原备注','原登记'),
  ],
};
