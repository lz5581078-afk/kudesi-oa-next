import { describe, expect, it } from 'vitest';
import { specificationWeightG, systemWeightG } from './product-weight';
describe('系统规格与名称规格独立计量',()=>{
 it('原料采购按斤时每倍500克，名称1克不改变采购计量',()=>{expect(systemWeightG('斤')).toBe(500);expect(specificationWeightG(1,'G')).toBe(1);expect(systemWeightG('0.000001千克')).toBe(0.001);});
 it('不可识别的体积和计数不伪造重量',()=>{expect(systemWeightG('包')).toBeNull();expect(specificationWeightG(5,'ML')).toBeNull();expect(specificationWeightG('', 'G')).toBeNull();});
});
