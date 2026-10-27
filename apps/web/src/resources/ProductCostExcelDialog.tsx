import { useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { downloadXlsx, readXlsxRows } from './xlsx';

interface Issue { sheet: string; row: number; field: string; message: string }
interface Result { errors: Issue[]; warnings: Issue[]; created: number; updated: number; rowCount: number; confirm?: string | null }
interface Table { headers: string[]; rows: string[][] }

/** 商品档案成本 Excel 导入导出：先预检，没有问题才能导入；同档案、成本类型、生效开始的记录是更新，其余新增。 */
export function ProductCostExcelDialog({ canImport, onClose, onDone }: { canImport: boolean; onClose: () => void; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Array<Record<string, string>> | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '操作失败');

  const download = async (path: string, name: string) => {
    setError('');
    try { const t = await api<Table>(path); await downloadXlsx(name, [t.headers, ...t.rows]); } catch (e) { fail(e); }
  };

  const pickFile = async (file: File) => {
    setError(''); setNotice(''); setResult(null); setRows(null); setBusy(true);
    try {
      const table = await readXlsxRows(file);
      const head = table[0] ?? [];
      const need = ['档案编号', '成本类型', '单位成本', '计价单位', '生效开始'];
      const miss = need.filter((h) => !head.includes(h));
      if (miss.length) throw new Error(`缺少列：${miss.join('、')}（请用导出或模板文件）`);
      const parsed = table.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
      setRows(parsed);
      setResult(await api<Result>('/finance/product-costs/import/preflight', { method: 'POST', body: { rows: parsed } }));
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const run = async () => {
    if (!rows || !result?.confirm) return;
    setBusy(true); setError('');
    try {
      const r = await api<Result>('/finance/product-costs/import/execute', { method: 'POST', body: { rows, confirm: result.confirm } });
      setNotice(`导入完成：新增 ${r.created} 条、更新 ${r.updated} 条。引用这些档案的自制品成本已自动重算。`);
      setRows(null); setResult(null); onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal wide card" role="dialog" aria-label="商品档案成本 Excel">
        <div className="modal-head"><strong>商品档案成本 Excel 导入导出</strong></div>
        <div className="modal-body">
          <p className="muted">每行一条成本记录：档案编号 + 成本类型（采购/调运/发货前包装/生产/发货包装/快递）+ 生效开始；同样的三项已有记录就更新，没有就新增，文件里没有的记录不会删除。手工锁定的记录不会被覆盖。</p>
          <div className="toolbar-row">
            <button type="button" className="secondary-button" onClick={() => void download('/finance/product-costs/export', '商品档案成本记录.xlsx')}>导出全部成本记录</button>
            {canImport && <button type="button" className="secondary-button" onClick={() => void download('/finance/product-costs/template', '商品档案成本导入模板.xlsx')}>下载模板</button>}
            {canImport && <button type="button" className="secondary-button" disabled={busy} onClick={() => input.current?.click()}>选择文件并预检</button>}
            <input ref={input} type="file" accept=".xlsx" hidden aria-label="选择档案成本文件" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickFile(f); }} />
          </div>
          {error && <p role="alert" className="form-error">{error}</p>}
          {notice && <p role="status" className="muted">{notice}</p>}
          {result && (
            <div>
              <p>预检：新增 {result.created} 条、更新 {result.updated} 条；问题 {result.errors.length} 个，提醒 {result.warnings.length} 个。</p>
              {[...result.errors.map((e) => ({ ...e, bad: true })), ...result.warnings.map((e) => ({ ...e, bad: false }))].slice(0, 100).map((e, i) => (
                <div key={i} className={e.bad ? 'form-error' : 'muted'}>{e.bad ? '问题' : '提醒'}：第 {e.row} 行{e.field ? `「${e.field}」` : ''} {e.message}</div>
              ))}
              {result.confirm && canImport && <button type="button" className="primary-button" disabled={busy} onClick={() => void run()}>确认导入</button>}
            </div>
          )}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}
