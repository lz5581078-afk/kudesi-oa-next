import { safeResult } from './speech-protocol';

describe('真实实时首句缺失句级时间的兼容', () => {
  it('使用供应商逐字原生时间补齐缺失句首，保留句尾并丢弃额外字段', () => {
    const r = safeResult({ result: { text: '欢迎朋友', utterances: [{ text: '欢迎朋友', definite: true, end_time: 4032,
      words: [{ start_time: 120, end_time: 360, text: '欢' }, { start_time: 360, end_time: 520, text: '迎' }], secret: 'never-return' }] } }, false);
    expect(r.result.utterances).toEqual([{ text: '欢迎朋友', definite: true, start_time: 120, end_time: 4032 }]);
    expect(JSON.stringify(r)).not.toContain('never-return');
  });
  it('完整原生句级时间（包括0）优先；缺失句尾可用原生词尾', () => {
    expect(safeResult({ result: { utterances: [{ start_time: 0, end_time: 900, words: [{ start_time: 120, end_time: 800 }] }] } }).result.utterances[0]).toMatchObject({ start_time: 0, end_time: 900 });
    expect(safeResult({ result: { utterances: [{ start_time: '120', words: [{ start_time: 120, end_time: 360 }, { start_time: 360, end_time: 800 }] }] } }).result.utterances[0]).toMatchObject({ start_time: 120, end_time: 800 });
  });
  it('未确认的临时文字可缺少时间；最终或已确认文字缺少所有时间须明确拒绝', () => {
    const body = { result: { utterances: [{ text: '临时文字', end_time: 800 }] } };
    expect(safeResult(body, false).result.utterances[0]).toMatchObject({ start_time: null, end_time: 800, definite: false });
    expect(() => safeResult(body, true)).toThrow('原生分句时间');
    expect(() => safeResult({ result: { utterances: [{ text: '确认', definite: true, end_time: 800 }] } }, false)).toThrow('原生分句时间');
  });
  it('空值、布尔、非数值及倒序不伪造成0；没有句子时保留空结果', () => {
    for (const start_time of [null, '', ' ', true, NaN, -1, Infinity, 'invalid'])
      expect(() => safeResult({ result: { utterances: [{ start_time, end_time: 800 }] } })).toThrow();
    expect(() => safeResult({ result: { utterances: [{ start_time: 900, end_time: 800 }] } })).toThrow();
    expect(safeResult({ result: {} })).toEqual({ result: { text: '', utterances: [] } });
  });
});
