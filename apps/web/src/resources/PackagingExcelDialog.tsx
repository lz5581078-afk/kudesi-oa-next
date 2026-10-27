import { useRef, useState } from 'react';
import readXlsxFile, { readSheetNames } from 'read-excel-file';
import writeXlsxFile from 'write-excel-file';
import { api, ApiError } from '../api/client';

const SHEETS = { schemes: '包装方案', lines: '包装方案明细', rules: '匹配规则' } as const;
const HEADERS = {
  schemes: ['方案编码', '方案名称', '使用场景', '商品分类', '品牌', '生效日期', '失效日期', '状态', '来源类型', '来源说明', '备注'],
  lines: ['方案编码', '包装档案编号', '角色', '数量', '单位', '损耗率', '成本归类', '计价处理', '来源行', '排序', '备注'],
  rules: ['方案编码', '目标类型', '目标编码', '商品分类', '品牌', '销售场景', '最小重量kg', '最大重量kg', '离散重量kg', '优先级', '状态', '备注'],
} as const;
type Key = keyof typeof SHEETS;
type Rows = Record<Key, Array<Record<string, string>>>;
interface Issue { sheet: string; row: number; field: string; message: string }
interface Result { errors: Issue[]; warnings: Issue[]; summary: { schemesCreated: number; schemesUpdated: number; lines: number; rules: number }; confirm?: string | null }
const keys = Object.keys(SHEETS) as Key[];

async function save(name: string, tables: Record<Key, string[][]>) {
  const data = keys.map((k) => tables[k].map((r, i) => r.map((v) => ({ type: String, value: v, ...(i === 0 ? { fontWeight: 'bold' as const } : {}) }))));
  const blob = (await writeXlsxFile(data as never, { sheets: keys.map((k) => SHEETS[k]) } as never)) as unknown as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** 包装方案 Excel 导入导出：方案、明细、匹配规则三张表，先预检，没问题再导入（整批同成同败）。 */
export function PackagingExcelDialog({ canCreate, onClose, onDone }: { canCreate: boolean; onClose: () => void; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Rows | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '操作失败');

  const exportAll = async () => {
    setError('');
    try { await save('包装方案.xlsx', await api('/finance/packaging/export')); } catch (e) { fail(e); }
  };
  const template = () => save('包装方案导入模板.xlsx', Object.fromEntries(keys.map((k) => [k, [[...HEADERS[k]]]])) as Record<Key, string[][]>);

  const pickFile = async (file: File) => {
    setError(''); setNotice(''); setResult(null); setRows(null); setBusy(true);
    try {
      const names = await readSheetNames(file);
      const parsed = {} as Rows;
      for (const k of keys) {
        if (!names.includes(SHEETS[k])) throw new Error(`缺少工作表“${SHEETS[k]}”（请用导出或模板文件）`);
        const table = (await readXlsxFile(file, { sheet: SHEETS[k] })).map((r) => r.map((c) => (c === null || c === undefined ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c).trim())));
        const head = table[0] ?? [];
        const miss = HEADERS[k].filter((h) => !head.includes(h));
        if (miss.length) throw new Error(`“${SHEETS[k]}”缺少列：${miss.join('、')}`);
        parsed[k] = table.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
      }
      setRows(parsed);
      setResult(await api<Result>('/finance/packaging/import/preflight', { method: 'POST', body: parsed }));
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const run = async () => {
    if (!rows || !result?.confirm) return;
    setBusy(true); setError('');
    try {
      const r = await api<Result>('/finance/packaging/import/execute', { method: 'POST', body: { ...rows, confirm: result.confirm } });
      setNotice(`导入完成：新建方案 ${r.summary.schemesCreated}、更新方案 ${r.summary.schemesUpdated}、明细 ${r.summary.lines}、规则 ${r.summary.rules}`);
      setRows(null); setResult(null); onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal wide card" role="dialog" aria-label="包装方案 Excel">
        <div className="modal-head"><strong>包装方案 Excel 导入导出</strong></div>
        <div className="modal-body">
          <p className="muted">一个文件三张表：包装方案、包装方案明细、匹配规则。同方案编码再次导入会整套替换原来的明细和规则。先预检，没有问题才能导入。</p>
          <div className="toolbar-row">
            <button type="button" className="secondary-button" onClick={() => void exportAll()}>导出当前全部</button>
            <button type="button" className="secondary-button" onClick={() => void template()}>下载模板</button>
            {canCreate && <button type="button" className="secondary-button" disabled={busy} onClick={() => input.current?.click()}>选择文件并预检</button>}
            <input ref={input} type="file" accept=".xlsx" hidden aria-label="选择包装方案文件" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickFile(f); }} />
          </div>
          {error && <p role="alert" className="form-error">{error}</p>}
          {notice && <p role="status" className="muted">{notice}</p>}
          {result && (
            <div>
              <p>预检：新建方案 {result.summary.schemesCreated}、更新方案 {result.summary.schemesUpdated}、明细 {result.summary.lines}、规则 {result.summary.rules}；问题 {result.errors.length} 个，提醒 {result.warnings.length} 个。</p>
              {[...result.errors.map((e) => ({ ...e, bad: true })), ...result.warnings.map((e) => ({ ...e, bad: false }))].slice(0, 100).map((e, i) => (
                <div key={i} className={e.bad ? 'form-error' : 'muted'}>{e.bad ? '问题' : '提醒'}：{e.sheet} 第 {e.row} 行{e.field ? `「${e.field}」` : ''} {e.message}</div>
              ))}
              {result.confirm && canCreate && <button type="button" className="primary-button" disabled={busy} onClick={() => void run()}>确认导入</button>}
            </div>
          )}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}
