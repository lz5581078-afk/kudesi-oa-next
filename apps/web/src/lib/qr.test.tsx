import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { qrMatrix, qrSvgPath, qrVersionFor } from './qr';

const hash = (t: string) => createHash('sha256').update(qrMatrix(t).map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16);

describe('二维码生成', () => {
  it('按内容长度选版本，太长报错', () => {
    expect(qrVersionFor(14)).toBe(1);
    expect(qrVersionFor(15)).toBe(2);
    expect(qrVersionFor(212)).toBe(10);
    expect(() => qrVersionFor(300)).toThrow(/太长/);
  });

  it('结果和用 jsQR 解码验证过的版本一致（同样内容同样的图）', () => {
    // 这两个值是用独立的解码器（jsQR）逐个扫出原文后记下的；改了算法这里会变，必须重新扫码验证
    expect(hash('https://lc.kudesi.com/m/upload#abc')).toBe('87671aa6255659fe');
    expect(qrMatrix('https://lc.kudesi.com/m/upload#abc')).toHaveLength(29);
    expect(hash('v'.repeat(190))).toBe('509d568a00d9fdb3');
    expect(qrMatrix('v'.repeat(190))).toHaveLength(57);
  });

  it('三个角都有定位图形，路径能画出黑块', () => {
    const m = qrMatrix('hello');
    const n = m.length;
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      expect(m[r][c] && m[r][c + 6] && m[r + 6][c] && m[r + 6][c + 6] && m[r + 3][c + 3]).toBe(true);
      expect(m[r + 1][c + 1]).toBe(false);
    }
    const { path, size } = qrSvgPath(m);
    expect(size).toBe(n + 8);
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true);
  });
});
