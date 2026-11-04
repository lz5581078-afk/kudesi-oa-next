/** 单价保留到百万分之一元（万分之一分）。结算金额仍用整数分。 */
export const UNIT_CENT_SCALE = 4;
/** 档案运费/装卸费保留八位元；仅显式调用使用，不改变普通单价精度。 */
export const LOGISTICS_CENT_SCALE = 6;
const TICKS = 10_000n;
export function scaledDecimal(value: number | string, scale: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(String(value));
  if (!m || /[1-9]/.test((m[3] ?? '').slice(scale))) throw new Error('小数精度超出支持范围');
  const n = BigInt(m[2]) * 10n ** BigInt(scale) + BigInt(((m[3] ?? '') + '0'.repeat(scale)).slice(0, scale) || '0');
  return m[1] ? -n : n;
}
export function validUnitCents(value: unknown, scale = UNIT_CENT_SCALE): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 99_999_999_999) return false;
  try { const ticks=scaledDecimal(value, scale); if(scale>UNIT_CENT_SCALE)numberFromTicks(ticks,scale); return true; } catch { return false; }
}
export function yuanToPreciseCents(value: string | number, centScale = UNIT_CENT_SCALE): number {
  return numberFromTicks(scaledDecimal(value, centScale + 2),centScale);
}
export function unitCentsTicks(value: number, centScale=UNIT_CENT_SCALE): bigint { return scaledDecimal(value, centScale); }
const roundRatio = (n: bigint, d: bigint) => n < 0n ? -((-n + d / 2n) / d) : (n + d / 2n) / d;
const safeInteger = (value:bigint):number => { if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('金额超出安全整数范围');return Number(value); };
function numberFromTicks(ticks:bigint,scale:number):number {
  const value=(scale>UNIT_CENT_SCALE?safeInteger(ticks):Number(ticks))/10**scale;
  // 即使 ticks 可表示，转成 JSON number 后也必须能还原同一最小金额单位。
  if(scale>UNIT_CENT_SCALE&&scaledDecimal(value,scale)!==ticks)throw new Error('金额超出安全整数范围');
  return value;
}
export function sumUnitCents(values: number[],centScale=UNIT_CENT_SCALE): number { return numberFromTicks(values.reduce((s,v)=>s+unitCentsTicks(v,centScale),0n),centScale); }
export function multiplyUnitCents(value: number, quantity: number, lossPercent = 0, quantityScale:4|6 = 4,centScale=UNIT_CENT_SCALE,outputScale=centScale): number {
  const n = unitCentsTicks(value,centScale) * scaledDecimal(quantity,quantityScale) * (100_000_000n + scaledDecimal(lossPercent,6));
  const factor=10n ** BigInt(quantityScale)*100_000_000n;
  const rounded=outputScale<=centScale?roundRatio(n,factor*10n**BigInt(centScale-outputScale)):roundRatio(n*10n**BigInt(outputScale-centScale),factor);
  if(quantityScale===6&&outputScale===UNIT_CENT_SCALE)safeInteger(rounded);
  return numberFromTicks(rounded,outputScale);
}
export interface UnitCentsProduct {value:number;quantity:number;lossPercent?:number}
/** 各组成先保留完整乘积，合计后才按结果精度舍入；数量精度和金额精度互相独立。 */
export function sumUnitCentsProducts(terms:UnitCentsProduct[],quantityScale:4|6=6,centScale=UNIT_CENT_SCALE,outputScale=centScale):number {
  const numerator=terms.reduce((sum,term)=>sum+unitCentsTicks(term.value,centScale)*scaledDecimal(term.quantity,quantityScale)*(100_000_000n+scaledDecimal(term.lossPercent??0,6)),0n);
  const factor=10n**BigInt(quantityScale)*100_000_000n;
  const ticks=outputScale<=centScale?roundRatio(numerator,factor*10n**BigInt(centScale-outputScale)):roundRatio(numerator*10n**BigInt(outputScale-centScale),factor);
  if(quantityScale===6&&outputScale===UNIT_CENT_SCALE)safeInteger(ticks);
  return numberFromTicks(ticks,outputScale);
}
/** 仅在已声明的报价/台账终点调用，不用于逐组成截断。 */
export function quantizeUnitCents(value:number,inputScale:number,outputScale:number):number {
  const ticks=unitCentsTicks(value,inputScale);
  const converted=outputScale<inputScale?roundRatio(ticks,10n**BigInt(inputScale-outputScale)):ticks*10n**BigInt(outputScale-inputScale);
  safeInteger(converted);
  return numberFromTicks(converted,outputScale);
}
/** 单据行在数量乘单价之后才结算到分，避免先舍入单价。 */
export function settledLineCents(value: number, quantity: number): number {
  return safeInteger(roundRatio(unitCentsTicks(value) * scaledDecimal(quantity,4), TICKS * 10_000n));
}
export function unitYuanText(cents: number,centScale=UNIT_CENT_SCALE): string {
  if(centScale===UNIT_CENT_SCALE)return (cents / 100).toFixed(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const ticks=unitCentsTicks(cents,centScale),negative=ticks<0n,digits=String(negative?-ticks:ticks).padStart(centScale+3,'0');
  return `${negative?'-':''}${digits.slice(0,-centScale-2)}.${digits.slice(-centScale-2)}`.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** 库存结算总额除以四位数量，平均报价保留万分之一分；零/负数量无平均报价。 */
export function averageUnitCents(totalCents: number, quantity: number): number | null {
  if (!Number.isSafeInteger(totalCents)) throw new Error('结算总额必须为安全整数分');
  const qty = scaledDecimal(quantity, 4);
  if (qty <= 0n) return null;
  return Number(roundRatio(BigInt(totalCents) * TICKS * 10_000n, qty)) / Number(TICKS);
}
