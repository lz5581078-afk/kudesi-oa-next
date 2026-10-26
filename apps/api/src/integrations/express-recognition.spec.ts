import { PROVINCES } from '@kudesi/shared';
import { buildXlsx } from '../resources/xlsx-lite';
import { OcrService } from './ocr.service';
import { normalizePriceTable, normalizeSurchargeNotice, parseWeightScope, xlsxToText } from './express-recognition';
import { VisionClient } from './vision.client';

describe('快递价格表识别整理', () => {
  it('重量范围文字：区间、以上、以内、通用、开闭', () => {
    expect(parseWeightScope('3.21-7kg')).toEqual({ start: 3.21, end: 7, startInclusive: true, endInclusive: true });
    expect(parseWeightScope('7公斤以上')).toMatchObject({ start: 7, end: null });
    expect(parseWeightScope('2kg以内')).toMatchObject({ start: 0, end: 2 });
    expect(parseWeightScope('通用')).toMatchObject({ start: 0, end: null });
    expect(parseWeightScope('超过3kg')).toMatchObject({ start: 3, startInclusive: false });
    expect(parseWeightScope('≥1kg 且 <5kg')).toMatchObject({ start: 1, end: 5, endInclusive: false });
    expect(parseWeightScope('看不懂')).toBeNull();
  });

  it('价格表：标准档位列 + 非标准区间 + 首重续重公式，金额转成分，多省份拆开', () => {
    const out = normalizePriceTable({
      effectiveStart: '2026年3月1日',
      extraRemark: '退改费用：10元',
      priceRows: [
        { province: '广东', price500g: 1.25, price1kg: '1.55', priceRules: [{ weightScope: '3.21-7kg', baseAmount: 6.8, ruleType: 'fixed' }, { weightScope: '7.01-30kg', ruleType: 'formula', firstWeightType: '0', firstWeightAmount: 3.5, continuedWeightAmount: 0.5 }] },
        { province: '新疆、西藏、火星', commonPrice: 9 },
        { province: '不认识的地方', price1kg: 2 },
      ],
    }, PROVINCES);
    const gd = out.rows.filter((r) => r.province === '广东');
    expect(gd).toHaveLength(4);
    expect(gd[0]).toMatchObject({ shipWeightMin: 0, shipWeightMax: 0.5, fixedPrice: 125, minExclusive: false });
    expect(gd[1]).toMatchObject({ shipWeightMin: 0.5, shipWeightMax: 1, fixedPrice: 155, minExclusive: true });
    expect(gd[2]).toMatchObject({ shipWeightMin: 3.21, shipWeightMax: 7, fixedPrice: 680 });
    expect(gd[3]).toMatchObject({ shipWeightMin: 7.01, shipWeightMax: 30, fixedPrice: null, firstWeight: 0, firstPrice: 350, extraPrice: 50 });
    expect(out.rows.filter((r) => ['新疆', '西藏'].includes(r.province))).toHaveLength(2);
    expect(out.rows.find((r) => r.province === '新疆')!.warnings[0]).toMatch(/火星/);
    expect(out.warnings.join()).toMatch(/不认识的地方/);
    expect(out.effectiveStart).toBe('2026-03-01');
    expect(out.extraRemark).toBe('退改费用：10元');
  });

  it('加收通知：多省份按省拆开；缺金额、缺重量给提醒；比例加收存百分数', () => {
    const out = normalizeSurchargeNotice({
      batchName: '广西云南加收',
      surcharges: [
        { surchargeName: '偏远加收', provinceList: ['广西', '云南'], chargeType: 'per_kg', amount: 1.5, effectiveStart: '2026-06-01', weightMode: 'above', weightStart: 1 },
        { surchargeName: '旺季', areaScope: '全部省份', chargeType: 'percent', amount: 8 },
        { surchargeName: '坏的', areaScope: '新疆', chargeType: 'fixed', amount: 0, weightMode: 'between', weightStart: 5, weightEnd: 2 },
      ],
    }, PROVINCES);
    expect(out.batchName).toBe('广西云南加收');
    expect(out.rows).toHaveLength(4);
    expect(out.rows[0]).toMatchObject({ areaScope: '广西', chargeType: 'per_kg', amount: 150, weightMode: 'above', weightStart: 1, weightEnd: null });
    expect(out.rows[2]).toMatchObject({ areaScope: '全部省份', chargeType: 'percent', amount: null, percent: 8 });
    expect(out.rows[3].warnings.length).toBe(2);
  });

  it('Excel 里的文字能读出来；识别服务：图片走视觉、表格走文字、没权限拒绝', async () => {
    const xlsx = buildXlsx('报价', [{ header: '省份', width: 10 }, { header: '首重', width: 10 }], [['广东', 3.5], ['新疆', 9]]);
    const t = xlsxToText(xlsx);
    expect(t).toContain('广东\t3.5');
    const prompts: string[] = [];
    const settings = { getVision: async () => ({ baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm1', enabled: true }) };
    const ocr = new OcrService(settings as never);
    ocr.visionFactory = (cfg) => new VisionClient(cfg, (async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      prompts.push(typeof body.messages[0].content === 'string' ? 'text' : 'image');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"priceRows":[{"province":"广东","commonPrice":3.5},{"province":"新疆","commonPrice":9}]}' } }] }), { status: 200 });
    }) as unknown as typeof fetch);
    const boss = { id: 1, companyId: 1, name: 'b', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const r = await ocr.recognizeExpressDocument(boss, { originalname: '报价.xlsx', buffer: xlsx, size: xlsx.length }, 'price_table', PROVINCES);
    expect(r.modelName).toBe('m1');
    expect((r as { rows: unknown[] }).rows).toHaveLength(2);
    const csv = Buffer.from('省份,价格\n广东,3.5\n');
    await ocr.recognizeExpressDocument(boss, { originalname: 'a.csv', buffer: csv, size: csv.length }, 'price_table', PROVINCES);
    expect(prompts).toEqual(['text', 'text']);
    const nobody = { ...boss, permissions: { isCompanyAdmin: false, allow: [], deny: [] } };
    await expect(ocr.recognizeExpressDocument(nobody, { originalname: 'a.csv', buffer: csv, size: csv.length }, 'price_table', PROVINCES)).rejects.toThrow(/没有权限/);
    const bin = Buffer.from([0, 1, 2, 3, 0, 0, 9]);
    await expect(ocr.recognizeExpressDocument(boss, { originalname: 'a.bin', buffer: bin, size: bin.length }, 'price_table', PROVINCES)).rejects.toThrow(/只能识别/);
  });
});
