import {expect,it} from 'vitest';
import {skuApplicationTime} from './skuApplicationTime';
it('SKU时间按上海无秒展示，不受浏览器本地时区影响；数据库无offset是北京时间',()=>{expect(skuApplicationTime('2026-10-24T10:00:00Z')).toBe('2026-10-24 18:00');expect(skuApplicationTime('2026-10-24 10:00:00')).toBe('2026-10-24 10:00');expect(skuApplicationTime('2026-10-24T06:00:00-04:00')).toBe('2026-10-24 18:00');expect(skuApplicationTime(null)).toBe('');expect(skuApplicationTime('bad')).toBe('');});
