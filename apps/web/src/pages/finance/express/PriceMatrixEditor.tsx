import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../api/client';
import { expressApi, type RuleRow } from './expressApi';
import { downloadText } from '../../../resources/csv';
import { parseRulesCsv, priceTemplateCsv, rulesToCsv } from './priceCsv';
import { MATRIX_ROWS, cellKey, columnId, columnLabel, matrixToRules, rulesToMatrix, standardColumns, type MatrixCells, type MatrixColumn } from './matrix';

/** 价格矩阵编辑：省份 × 重量段。保存时整表替换这一套（AI 识别 / 手工）价格。 */
export function PriceMatrixEditor({ versionId, source, rules, canEdit, onSaved }: {
  versionId: number; source: 'ai' | 'manual'; rules: RuleRow[]; canEdit: boolean; onSaved: () => void;
}) {
  const initial = useMemo(() => rulesToMatrix(rules), [rules]);
  const [columns, setColumns] = useState<MatrixColumn[]>(initial.columns);
  const [cells, setCells] = useState<MatrixCells>(initial.cells);
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => { setColumns(initial.columns); setCells(initial.cells); setDirty(false); setErrors([]); }, [initial]);

  const setCell = (province: string, col: MatrixColumn, part: 'a' | 'b', value: string) => {
    setDirty(true);
    setCells((c) => ({ ...c, [cellKey(province, col.id)]: { a: c[cellKey(province, col.id)]?.a ?? '', b: c[cellKey(province, col.id)]?.b ?? '', [part]: value } }));
  };
  const fillColumn = (col: MatrixColumn) => {
    const a = window.prompt(`把「${columnLabel(col)}」这一列所有省份都填成同一个价格（元）。已有的价格会被覆盖。`, '');
    if (a === null) return;
    const b = col.mode === 'formula' ? window.prompt('续重价（元/公斤）', '') ?? '' : '';
    setDirty(true);
    setCells((c) => {
      const next = { ...c };
      for (const r of MATRIX_ROWS.filter((x) => x.value !== 'ALL')) next[cellKey(r.value, col.id)] = { a, b };
      return next;
    });
  };
  const removeColumn = (col: MatrixColumn) => {
    setDirty(true);
    setColumns((cs) => cs.filter((c) => c.id !== col.id));
  };
  const addColumns = (more: MatrixColumn[]) => {
    setDirty(true);
    setColumns((cs) => [...cs, ...more.filter((m) => !cs.some((c) => c.id === m.id))].sort((x, y) => x.start - y.start || (x.end ?? Infinity) - (y.end ?? Infinity)));
  };

  async function importCsv(file: File | undefined) {
    if (!file) return;
    const text = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result ?? '')); r.onerror = () => reject(new Error('文件读取失败')); r.readAsText(file, 'utf-8'); });
    const out = parseRulesCsv(text);
    setErrors(out.errors);
    if (out.errors.length) return;
    const m = rulesToMatrix(out.rules);
    setColumns(m.columns); setCells(m.cells); setDirty(true);
    setNotice(`已读入 ${out.rules.length} 条价格，检查后点“保存价格”才会生效`);
  }

  async function save() {
    const out = matrixToRules(columns, cells);
    setErrors(out.errors);
    if (out.errors.length) return;
    if (!out.rules.length && !window.confirm('现在表里一个价格都没有，保存会清空这一套价格。确定吗？')) return;
    setBusy(true); setNotice('');
    try {
      const r = await expressApi.saveRules(versionId, source, out.rules);
      setNotice(`已保存 ${r.created} 条价格规则`);
      setDirty(false);
      onSaved();
    } catch (e) { setErrors([e instanceof ApiError ? e.message : '保存失败']); }
    setBusy(false);
  }

  const rowsToShow = canEdit ? MATRIX_ROWS : MATRIX_ROWS.filter((r) => columns.some((c) => (cells[cellKey(r.value, c.id)]?.a ?? '') !== ''));
  return (
    <div>
      {canEdit && (
        <div className="toolbar">
          <button type="button" className="secondary-button" onClick={() => setAdding(true)}>+ 加一个重量段</button>
          <button type="button" className="secondary-button" onClick={() => addColumns(standardColumns())}>加入常用档位（0.5/1/2/3/4/5/6kg）</button>
          <button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存价格'}</button>
          {dirty && <span className="muted">有未保存的修改</span>}
        </div>
      )}
      {source === 'manual' && (
        <div className="toolbar">
          <button type="button" className="secondary-button" onClick={() => downloadText('快递价格表手工创建模板.csv', priceTemplateCsv())}>下载 CSV 模板</button>
          <button type="button" className="secondary-button" disabled={!rules.length} onClick={() => downloadText('当前快递价格表.csv', rulesToCsv(matrixToRules(columns, cells).rules))}>导出当前价格 CSV</button>
          {canEdit && <label className="secondary-button file-button">导入 CSV<input aria-label="导入价格表CSV" type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={(e) => { void importCsv(e.target.files?.[0]); e.target.value = ''; }} /></label>}
        </div>
      )}
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {errors.length > 0 && <div role="alert" className="notice error">{errors.slice(0, 6).map((e) => <div key={e}>{e}</div>)}{errors.length > 6 && <div>还有 {errors.length - 6} 处…</div>}</div>}
      {columns.length === 0 ? (
        <p className="muted">这一套价格还没有内容。点“加入常用档位”或“加一个重量段”开始，再按省份填价格；也可以用“AI 识别价格表”直接导入。</p>
      ) : (
        <div className="table-scroll"><table className="data-table" aria-label="价格矩阵">
          <thead><tr><th>省份</th>{columns.map((c) => (
            <th key={c.id}>{columnLabel(c)}
              {canEdit && <div className="row-actions"><button type="button" className="link-button" onClick={() => fillColumn(c)}>整列填</button><button type="button" className="link-button danger" onClick={() => removeColumn(c)}>删除列</button></div>}
            </th>))}</tr></thead>
          <tbody>
            {rowsToShow.map((r) => (
              <tr key={r.value}><th scope="row">{r.label}</th>
                {columns.map((c) => {
                  const cell = cells[cellKey(r.value, c.id)] ?? { a: '', b: '' };
                  return (
                    <td key={c.id}>
                      {canEdit ? (
                        <span className="matrix-cell">
                          <input aria-label={`${r.label} ${columnLabel(c)} ${c.mode === 'formula' ? '首重价' : '价格'}`} className="matrix-input" inputMode="decimal" value={cell.a} placeholder={c.mode === 'formula' ? '首重价' : '元'} onChange={(e) => setCell(r.value, c, 'a', e.target.value)} />
                          {c.mode === 'formula' && <input aria-label={`${r.label} ${columnLabel(c)} 续重价`} className="matrix-input" inputMode="decimal" value={cell.b} placeholder="续重/kg" onChange={(e) => setCell(r.value, c, 'b', e.target.value)} />}
                        </span>
                      ) : (cell.a === '' ? '—' : c.mode === 'formula' ? `${cell.a} + ${cell.b}/kg` : cell.a)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <p className="muted">价格单位：元。“全国统一”一行表示没有单独写省份时按它算，省份有专属价格就优先用专属价格。港澳台也可以填。</p>
      {adding && <ColumnDialog onClose={() => setAdding(false)} onAdd={(c) => { addColumns([c]); setAdding(false); }} />}
    </div>
  );
}

function ColumnDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (c: MatrixColumn) => void }) {
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('');
  const [startEx, setStartEx] = useState(false);
  const [endEx, setEndEx] = useState(false);
  const [mode, setMode] = useState<'fixed' | 'formula'>('fixed');
  const [first, setFirst] = useState<'0' | '1'>('1');
  const [error, setError] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const s = Number(start);
    const en = end.trim() === '' ? null : Number(end);
    if (!Number.isFinite(s) || s < 0) return setError('重量下限要填大于等于 0 的数字');
    if (en !== null && (!Number.isFinite(en) || en <= s)) return setError('重量上限必须大于下限，或留空表示不限');
    const c: MatrixColumn = { id: '', start: s, end: en, startExclusive: startEx, endExclusive: endEx, mode, firstWeight: first === '0' ? 0 : 1 };
    c.id = columnId(c);
    onAdd(c);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="加一个重量段" onSubmit={submit}>
        <div className="modal-head"><strong>加一个重量段</strong></div>
        <div className="modal-body">
          <label>重量下限（kg）<input value={start} inputMode="decimal" onChange={(e) => setStart(e.target.value)} /></label>
          <label className="inline"><input type="checkbox" checked={startEx} onChange={(e) => setStartEx(e.target.checked)} /> 下限不含（要大于它，如 &gt;0.5kg）</label>
          <label>重量上限（kg，空 = 不限）<input value={end} inputMode="decimal" onChange={(e) => setEnd(e.target.value)} /></label>
          <label className="inline"><input type="checkbox" checked={endEx} onChange={(e) => setEndEx(e.target.checked)} /> 上限不含（要小于它）</label>
          <label>计费方式<select value={mode} onChange={(e) => setMode(e.target.value as 'fixed' | 'formula')}><option value="fixed">固定价（这一段统一多少钱）</option><option value="formula">首重 + 续重（超出部分向上取整按公斤加）</option></select></label>
          {mode === 'formula' && <label>首重<select value={first} onChange={(e) => setFirst(e.target.value as '0' | '1')}><option value="1">首重 1 公斤</option><option value="0">首重 0 公斤（全部按续重算）</option></select></label>}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">加入</button></div>
      </form>
    </div>
  );
}
