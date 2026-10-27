/**
 * 极简二维码生成（字节模式、纠错等级 M、版本 1～10，够放一条上传链接）。
 * 流程：数据编码 → 里德-所罗门纠错 → 按块交织 → 摆放功能图形和数据 → 选罚分最低的掩码 → 写格式信息/版本信息。
 */

// [总码字数, 每块纠错码字数, 第一组块数, 第一组每块数据码字, 第二组块数, 第二组每块数据码字]，纠错等级 M
const M_TABLE: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [26, 10, 1, 16, 0, 0], [44, 16, 1, 28, 0, 0], [70, 26, 1, 44, 0, 0], [100, 18, 2, 32, 0, 0], [134, 24, 2, 43, 0, 0],
  [172, 16, 4, 27, 0, 0], [196, 18, 4, 31, 0, 0], [242, 22, 2, 38, 2, 39], [292, 22, 3, 36, 2, 37], [346, 26, 4, 43, 1, 44],
];
const ALIGN: ReadonlyArray<readonly number[]> = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsRemainder(data: number[], ecLen: number): number[] {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    gen = next;
  }
  const rem = new Array(ecLen).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift()!;
    rem.push(0);
    if (f) for (let i = 0; i < ecLen; i++) rem[i] ^= mul(gen[i + 1], f);
  }
  return rem;
}

function bch(value: number, poly: number, polyBits: number): number {
  let v = value << (polyBits - 1);
  for (let i = 31; i >= polyBits - 1; i--) if ((v >> i) & 1) v ^= poly << (i - polyBits + 1);
  return v;
}
const formatBits = (mask: number) => ((((0b00 << 3) | mask) << 10) | bch((0b00 << 3) | mask, 0x537, 11)) ^ 0x5412; // M 级 = 00
const versionBits = (version: number) => (version << 12) | bch(version, 0x1f25, 13);

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function utf8(text: string): number[] { return Array.from(new TextEncoder().encode(text)); }

export function qrVersionFor(byteLength: number): number {
  for (let v = 1; v <= 10; v++) {
    const [total, ec, g1, d1, g2, d2] = M_TABLE[v - 1];
    void total; void ec;
    const dataCw = g1 * d1 + g2 * d2;
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCw * 8) return v;
  }
  throw new Error('二维码内容太长');
}

function dataCodewords(bytes: number[], version: number): number[] {
  const [, , g1, d1, g2, d2] = M_TABLE[version - 1];
  const capacity = (g1 * d1 + g2 * d2) * 8;
  const bits: number[] = [];
  const push = (value: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data: number[], version: number): number[] {
  const [, ecLen, g1, d1, g2, d2] = M_TABLE[version - 1];
  const blocks: number[][] = [];
  let at = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const len = i < g1 ? d1 : d2;
    blocks.push(data.slice(at, at + len));
    at += len;
  }
  const ecs = blocks.map((b) => rsRemainder(b, ecLen));
  const out: number[] = [];
  const longest = Math.max(d1, d2);
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

/** 生成二维码：返回 size×size 的矩阵，true = 黑块 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = utf8(text);
  const version = qrVersionFor(bytes.length);
  const size = 17 + 4 * version;
  const codewords = interleave(dataCodewords(bytes, version), version);
  const base: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r: number, c: number, v: boolean) => { if (r >= 0 && r < size && c >= 0 && c < size) { base[r][c] = v; fixed[r][c] = true; } };

  const finder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      set(r0 + dr, c0 + dc, dark);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const pos = ALIGN[version - 1];
  const lastPos = pos[pos.length - 1];
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === lastPos) || (r === lastPos && c === 6)) continue; // 和三个定位图形重叠的跳过
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(size - 8, 8, true); // 固定黑块
  // 预留格式信息区
  for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  set(size - 8, 8, true);
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vb >> i) & 1) === 1;
      const a = Math.floor(i / 3), b = (i % 3) + size - 11;
      set(a, b, bit); set(b, a, bit);
    }
  }

  // 数据从右下角开始，两列一组，蛇形向上/向下
  const bits: boolean[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push(((cw >> i) & 1) === 1);
  const place = (mask: number): boolean[][] => {
    const m = base.map((row) => row.slice());
    let k = 0;
    let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let i = 0; i < size; i++) {
        const r = up ? size - 1 - i : i;
        for (let dc = 0; dc < 2; dc++) {
          const c = col - dc;
          if (fixed[r][c]) continue;
          const bit = k < bits.length ? bits[k] : false;
          k++;
          m[r][c] = bit !== MASKS[mask](r, c);
        }
      }
      up = !up;
    }
    const fb = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const bit = ((fb >> i) & 1) === 1;
      // 左上角周围
      if (i < 6) m[i][8] = bit; else if (i < 8) m[i + 1][8] = bit; else if (i === 8) m[8][7] = bit; else m[8][14 - i] = bit;
      // 另外两处
      if (i < 8) m[8][size - 1 - i] = bit; else m[size - 15 + i][8] = bit;
    }
    m[size - 8][8] = true;
    return m;
  };

  let best = place(0);
  let bestScore = penalty(best);
  for (let mask = 1; mask < 8; mask++) {
    const m = place(mask);
    const s = penalty(m);
    if (s < bestScore) { best = m; bestScore = s; }
  }
  return best;
}

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const runs = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        if (get(i, j) === get(i, j - 1)) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  };
  runs((i, j) => m[i][j]);
  runs((i, j) => m[j][i]);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const rev = [...pat].reverse();
  const match = (get: (k: number) => boolean, p: boolean[]) => p.every((v, k) => get(k) === v);
  for (let i = 0; i < n; i++) for (let j = 0; j <= n - 11; j++) {
    if (match((k) => m[i][j + k], pat) || match((k) => m[i][j + k], rev)) score += 40;
    if (match((k) => m[j + k][i], pat) || match((k) => m[j + k][i], rev)) score += 40;
  }
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** 转成 SVG 路径，供 <svg viewBox> 直接画；quiet 是四周留白的格数 */
export function qrSvgPath(matrix: boolean[][], quiet = 4): { path: string; size: number } {
  let path = '';
  matrix.forEach((row, r) => row.forEach((v, c) => { if (v) path += `M${c + quiet} ${r + quiet}h1v1h-1z`; }));
  return { path, size: matrix.length + quiet * 2 };
}
