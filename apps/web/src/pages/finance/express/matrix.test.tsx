import { describe, expect, it } from 'vitest';
import { cellKey, matrixToRules, rulesToMatrix, standardColumns } from './matrix';

describe('价格矩阵', () => {
  it('规则 → 矩阵 → 规则 原样往返（固定价、首重续重、开闭区间、不限上限）', () => {
    const rules = [
      { province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 300 },
      { province: '新疆', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 800 },
      { province: 'ALL', shipWeightMin: 1, shipWeightMax: null, minExclusive: true, firstWeight: 0 as const, firstPrice: 350, extraPrice: 50 },
    ];
    const { columns, cells } = rulesToMatrix(rules);
    expect(columns).toHaveLength(2);
    expect(cells[cellKey('广东', columns[0].id)].a).toBe('3');
    const back = matrixToRules(columns, cells);
    expect(back.errors).toEqual([]);
    expect(back.rules).toEqual(expect.arrayContaining(rules.map((r) => expect.objectContaining(r))));
    expect(back.rules).toHaveLength(3);
  });

  it('金额不合法、重量段不合法都会指出是哪个格子', () => {
    const cols = standardColumns();
    const bad = matrixToRules(cols, { [cellKey('广东', cols[0].id)]: { a: '1.234', b: '' } });
    expect(bad.errors[0]).toMatch(/广东/);
    const formula = rulesToMatrix([{ province: '广东', shipWeightMin: 1, shipWeightMax: null, firstWeight: 1, firstPrice: 100, extraPrice: 20 }]);
    formula.cells[cellKey('广东', formula.columns[0].id)].b = '';
    expect(matrixToRules(formula.columns, formula.cells).errors[0]).toMatch(/续重价/);
    const wrong = { ...cols[0], end: 0 };
    expect(matrixToRules([wrong], {}).errors[0]).toMatch(/上限必须大于下限/);
  });

  it('标准档位 7 列，第一列含 0，后面的下限不含', () => {
    const cols = standardColumns();
    expect(cols).toHaveLength(7);
    expect(cols[0].startExclusive).toBe(false);
    expect(cols[1].startExclusive).toBe(true);
  });
});
