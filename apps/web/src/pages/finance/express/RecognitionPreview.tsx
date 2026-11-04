import { centsToYuan, yuanToCents } from '../common';
import type { PriceRecognition, RuleRow, SurchargeDraft, SurchargeRecognition } from './expressApi';

type Recognition = PriceRecognition | SurchargeRecognition;
export type RecognitionEdits = Record<number, Record<string, string>>;
const fieldValue = (row: object, edits: RecognitionEdits, index: number, field: string) => edits[index]?.[field] ?? String((row as Record<string, unknown>)[field] ?? '');
const monetary = new Set(['fixedPrice', 'firstPrice', 'extraPrice', 'amount']);

/** Keep raw input until confirmation so clearing or correcting a value never silently becomes zero. */
export function correctedRecognitionRows(result: Recognition, edits: RecognitionEdits, skip: Set<number>): Array<RuleRow | Omit<SurchargeDraft, 'warnings'>> {
  return result.rows.flatMap((row, index) => {
    if (skip.has(index)) return [];
    const { warnings: _warnings, ...original } = row;
    const corrected: Record<string, unknown> = { ...original };
    const formula = result.kind === 'price_table' && (edits[index]?.ruleType ?? ((row as RuleRow).fixedPrice == null ? 'formula' : 'fixed')) === 'formula';
    const chargeType = edits[index]?.chargeType ?? (row as SurchargeDraft).chargeType;
    for (const [field, text] of Object.entries(edits[index] ?? {})) {
      if (result.kind === 'price_table' && (formula ? field === 'fixedPrice' : ['firstWeight', 'firstPrice', 'extraPrice'].includes(field))) continue;
      if (result.kind === 'surcharge_notice' && (chargeType === 'percent' ? field === 'amount' : field === 'percent')) continue;
      if (field === 'ruleType') continue;
      if (['note', 'province', 'name', 'areaScope', 'effectiveStart', 'effectiveEnd', 'chargeType', 'weightMode'].includes(field)) {
        corrected[field] = text.trim();
      } else {
        const value = text.trim() === '' ? null : monetary.has(field) ? yuanToCents(text) : Number(text);
        if (value !== null && (!Number.isFinite(value) || value < 0 || monetary.has(field) && !Number.isSafeInteger(value))) throw new Error(`第${index + 1}行：请填写有效的非负数字，金额最多两位小数`);
        corrected[field] = value;
      }
    }
    if (result.kind === 'price_table') {
      if (formula) corrected.fixedPrice = null;
      else if (edits[index]?.ruleType) { corrected.firstWeight = null; corrected.firstPrice = null; corrected.extraPrice = null; }
      if (!String(corrected.province ?? '').trim()) throw new Error(`第${index + 1}行：请填写省份/区域`);
      if (formula ? corrected.firstWeight == null || corrected.firstPrice == null || corrected.extraPrice == null : corrected.fixedPrice == null) throw new Error(`第${index + 1}行：请填写区间统一价，或完整的首重金额与续重金额`);
    } else {
      if (!String(corrected.name ?? '').trim()) throw new Error(`第${index + 1}行：请填写加收名称`);
      if (corrected.chargeType === 'percent') corrected.amount = null;
      else corrected.percent = null;
      if (corrected.weightMode === 'all') { corrected.weightStart = null; corrected.weightEnd = null; }
      if (corrected.weightMode === 'below') corrected.weightStart = null;
      if (corrected.weightMode === 'above') corrected.weightEnd = null;
      if (corrected.weightMode === 'between' && (corrected.weightStart == null || corrected.weightEnd == null)) throw new Error(`第${index + 1}行：区间重量需要填写起始和结束重量`);
      if (corrected.weightMode === 'below' && corrected.weightEnd == null || corrected.weightMode === 'above' && corrected.weightStart == null) throw new Error(`第${index + 1}行：请填写适用重量`);
      if (corrected.effectiveStart && corrected.effectiveEnd && String(corrected.effectiveEnd) < String(corrected.effectiveStart)) throw new Error(`第${index + 1}行：结束日期不能早于开始日期`);
      if (corrected.chargeType === 'percent' ? corrected.percent == null : corrected.amount == null) throw new Error(`第${index + 1}行：请填写加收值`);
    }
    const min = corrected.shipWeightMin ?? corrected.weightStart;
    const max = corrected.shipWeightMax ?? corrected.weightEnd;
    if (min != null && max != null && Number(max) <= Number(min)) throw new Error(`第${index + 1}行：结束重量必须大于起始重量`);
    return [corrected as unknown as RuleRow | Omit<SurchargeDraft, 'warnings'>];
  });
}

export function RecognitionPreview({ result, edits, skip, busy, onEdit, onToggle, onAdd, onRemove }: {
  result: Recognition; edits: RecognitionEdits; skip: Set<number>; busy: boolean;
  onEdit: (index: number, field: string, value: string) => void; onToggle: (index: number, checked: boolean) => void; onAdd: (index: number, mode: 'fixed' | 'formula') => void; onRemove: (index: number) => void;
}) {
  const input = (row: object, i: number, field: string, label: string, type = 'text', inactive = false) => {
    const stored = fieldValue(row, {}, i, field);
    const value = edits[i]?.[field] ?? (monetary.has(field) ? centsToYuan(stored === '' ? null : Number(stored)) : stored);
    return <input aria-label={`第${i + 1}行${label}`} type={type} step={type === 'number' ? 'any' : undefined} min={type === 'number' ? 0 : undefined} disabled={busy || inactive} value={value} onChange={e => onEdit(i, field, e.target.value)} />;
  };
  const select = (row: object, i: number, field: string, label: string, values: Array<[string, string]>, inactive = false) => <select aria-label={`第${i + 1}行${label}`} disabled={busy || inactive} value={fieldValue(row, edits, i, field)} onChange={e => onEdit(i, field, e.target.value)}>{values.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select>;
  return <div className="table-scroll"><table className="data-table express-recognition-preview">
    <thead>{result.kind === 'price_table' ? <tr><th>导入</th><th>省份/区域</th><th>起始重量 kg</th><th>结束重量 kg</th><th>规则类型</th><th>区间统一价（元）</th><th>首重 kg</th><th>首重金额（元）</th><th>续重/公斤（元）</th><th>备注</th><th>提醒</th><th>操作</th></tr> : <tr><th>导入</th><th>加收名称</th><th>开始</th><th>结束</th><th>省份/区域</th><th>重量模式</th><th>起始 kg</th><th>结束 kg</th><th>方式</th><th>加收值</th><th>备注</th><th>提醒</th></tr>}</thead>
    <tbody>{result.kind === 'price_table' ? result.rows.map((r, i) => {
      const formula = (edits[i]?.ruleType ?? (r.fixedPrice == null ? 'formula' : 'fixed')) === 'formula';
      return <tr key={i}>
      <td><input type="checkbox" aria-label={`导入第${i + 1}行`} disabled={busy} checked={!skip.has(i)} onChange={e => onToggle(i, e.target.checked)} /></td>
      <td>{input(r, i, 'province', '省份/区域')}</td><td>{input(r, i, 'shipWeightMin', '起始重量', 'number')}</td><td>{input(r, i, 'shipWeightMax', '结束重量', 'number')}</td>
      <td>{select({ ruleType: formula ? 'formula' : 'fixed' }, i, 'ruleType', '规则类型', [['fixed', '区间统一价'], ['formula', '首重续重']])}</td><td>{input(r, i, 'fixedPrice', '区间统一价', 'number', formula)}</td><td>{select(r, i, 'firstWeight', '首重类型', [['', '请选择'], ['0', '0公斤'], ['1', '1公斤']], !formula)}</td><td>{input(r, i, 'firstPrice', '首重金额', 'number', !formula)}</td><td>{input(r, i, 'extraPrice', '续重金额', 'number', !formula)}</td><td>{input(r, i, 'note', '备注')}</td><td className="bad-text">{r.warnings.join('；')}</td>
      <td className="row-actions"><button type="button" disabled={busy} onClick={() => onAdd(i, 'fixed')}>加区间</button><button type="button" disabled={busy} onClick={() => onAdd(i, 'formula')}>加公式</button><button type="button" disabled={busy} onClick={() => onRemove(i)}>删除规则</button></td>
    </tr>; }) : result.rows.map((r, i) => {
      const charge = fieldValue(r, edits, i, 'chargeType');
      return <tr key={i}><td><input type="checkbox" aria-label={`导入第${i + 1}行`} disabled={busy} checked={!skip.has(i)} onChange={e => onToggle(i, e.target.checked)} /></td>
        <td>{input(r, i, 'name', '加收名称')}</td><td>{input(r, i, 'effectiveStart', '开始日期', 'date')}</td><td>{input(r, i, 'effectiveEnd', '结束日期', 'date')}</td><td>{input(r, i, 'areaScope', '省份/区域')}</td>
        <td>{select(r, i, 'weightMode', '重量模式', [['all', '全部重量'], ['below', '以内'], ['above', '以上'], ['between', '区间']])}</td><td>{input(r, i, 'weightStart', '起始重量', 'number')}</td><td>{input(r, i, 'weightEnd', '结束重量', 'number')}</td>
        <td>{select(r, i, 'chargeType', '加收方式', [['fixed', '固定金额'], ['percent', '按比例'], ['per_kg', '按公斤']])}</td><td>{input(r, i, charge === 'percent' ? 'percent' : 'amount', charge === 'percent' ? '加收比例（%）' : '加收金额（元）', 'number')}</td><td>{input(r, i, 'note', '备注')}</td><td className="bad-text">{r.warnings.join('；')}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}
