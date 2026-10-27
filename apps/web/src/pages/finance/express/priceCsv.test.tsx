import { describe, expect, it } from 'vitest';
import { parseRulesCsv, priceTemplateCsv, rulesToCsv } from './priceCsv';

describe('手工价格表 CSV', () => {
  it('模板能被导入读回；导出再导入保持一致', () => {
    const t = parseRulesCsv(priceTemplateCsv());
    expect(t.errors).toEqual([]);
    expect(t.rules).toHaveLength(2);
    expect(t.rules[0]).toMatchObject({ province: '山东', shipWeightMin: 0, shipWeightMax: 0.5, fixedPrice: 125 });
    expect(t.rules[1]).toMatchObject({ firstWeight: 0, firstPrice: 350, extraPrice: 50, shipWeightMin: 7.01, shipWeightMax: 30, minExclusive: true });
    const again = parseRulesCsv(rulesToCsv(t.rules));
    expect(again.errors).toEqual([]);
    expect(again.rules).toEqual(t.rules);
  });
  it('全国统一、错误行带行号', () => {
    const r = parseRulesCsv('﻿省份,起始重量,结束重量,统一价\n全国,0,1,2.5\n火星,0,1,3\n山东省,2,1,3\n山东省,0,1,abc');
    expect(r.rules).toEqual([{ province: 'ALL', shipWeightMin: 0, shipWeightMax: 1, minExclusive: undefined, maxExclusive: undefined, fixedPrice: 250 }]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toContain('第 3 行');
  });
  it('表头不对时提示', () => {
    expect(parseRulesCsv('a,b\n1,2').errors[0]).toContain('表头');
  });
});
