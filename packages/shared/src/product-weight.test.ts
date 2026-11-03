import { describe, expect, it } from 'vitest';
import { specificationWeightG, systemWeightG } from './product-weight';
describe('系统规格与名称规格独立计量',()=>{
 it('原料采购按斤时每倍500克，名称1克不改变采购计量',()=>{expect(systemWeightG('斤')).toBe(500);expect(specificationWeightG(1,'G')).toBe(1);expect(systemWeightG('0.000001千克')).toBe(0.001);});
 it('文字规格仅识别明确重量，不把尺寸或前一个规格重量当作数量',()=>{expect(specificationWeightG('净含量500g','EA')).toBe(500);expect(specificationWeightG('25*33+4','G')).toBeNull();expect(specificationWeightG('1.5','KG')).toBe(1500);expect(specificationWeightG('50mg','EA')).toBe(0.05);});
 it('不可识别的体积和计数不伪造重量',()=>{expect(systemWeightG('包')).toBeNull();expect(specificationWeightG(5,'ML')).toBeNull();expect(specificationWeightG('', 'G')).toBeNull();});
});
