import {expect,it} from 'vitest';
import {formatOaDateTime} from './oaDateTime';
it('数据库北京时间壁钟和ISO瞬间显示一致，不跟随浏览器时区',()=>{
 expect(formatOaDateTime('2026-10-24 18:00',{seconds:false})).toBe('2026-10-24 18:00');
 expect(formatOaDateTime('2026-10-24T10:00:00Z',{seconds:false})).toBe('2026-10-24 18:00');
 expect(formatOaDateTime('2026-10-24T06:00:00-04:00')).toBe('2026-10-24 18:00:00');
});
it('日期型不退到前一天，午夜用00且空值/非法值不伪造时间',()=>{
 expect(formatOaDateTime('2026-10-24')).toBe('2026-10-24 00:00:00');
 expect(formatOaDateTime('2026-10-23T16:00:00Z')).toBe('2026-10-24 00:00:00');
 for(const value of [undefined,null,'','not-a-date',{}])expect(formatOaDateTime(value)).toBe('-');
 expect(formatOaDateTime(null,{empty:'未记录'})).toBe('未记录');
});
