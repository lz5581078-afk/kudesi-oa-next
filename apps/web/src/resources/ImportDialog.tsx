import { useEffect, useState } from 'react';
import { phoneStoreImportColumns, type ResourceDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { csvToObjects, downloadText, parseCsv, toCsv } from './csv';
import { resourceApi, type ImportBackupInfo, type ImportResult } from './api';
import { downloadXlsx, isXlsx, readXlsxRows } from './xlsx';

/** Excel 另存的 CSV 常是 GBK 编码：先按 UTF-8 严格解码，不行就按 GB18030。 */
async function readCsvText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}

/** 导入：先选文件 → 预览（逐行校验，不落库）→ 无错误才允许确认导入；有错整体不导入。 */
export function ImportDialog({ def, onClose, onDone }: { def: ResourceDef; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState<ImportBackupInfo[]>([]);
  const [restoreMsg, setRestoreMsg] = useState('');
  const loadBackups = () => resourceApi.importBackups(def.key).then(setBackups).catch(() => setBackups([]));
  useEffect(() => { void loadBackups(); }, [def.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const importable = def.fields.filter((f) => f.type !== 'secret' && f.type !== 'attrs' && !f.readonly);
  // 手机号导入：各平台“编号 / 店铺”列，把号码绑到对应平台的店铺
  const extraHeaders = def.key === 'phones' ? phoneStoreImportColumns().flatMap((c) => [c.noHeader, c.nameHeader]) : [];

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError('');
    setPreview(null);
    let objects: Array<Record<string, string>>;
    try {
      objects = csvToObjects(isXlsx(file) ? await readXlsxRows(file) : parseCsv(await readCsvText(file)));
    } catch {
      return setError('读不出这个文件，请用 .xlsx 或 .csv，第一行是表头');
    }
    if (objects.length === 0) return setError('文件里没有数据行（第一行应为表头）');
    if (objects.length > 2000) return setError('一次最多导入 2000 行');
    setRows(objects);
    setBusy(true);
    try {
      setPreview(await resourceApi.import(def.key, objects, true));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '预览失败');
    }
    setBusy(false);
  }

  async function commit(partial = false) {
    setBusy(true);
    try {
      const res = await resourceApi.import(def.key, rows, false, partial);
      if (!res.committed) {
        setPreview(res);
        setBusy(false);
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导入失败');
      setBusy(false);
    }
  }

  async function restore(b: ImportBackupInfo) {
    if (!window.confirm(`把「${def.label}」恢复到 ${new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false })} 导入前的样子（${b.recordCount} 条）？此后新增的记录会被删除。`)) return;
    setBusy(true);
    setError('');
    try {
      const r = await resourceApi.restoreBackup(def.key, b.id);
      setRestoreMsg(`已恢复 ${r.restored} 条${r.removed ? `，删除了之后新增的 ${r.removed} 条` : ''}${r.skippedDelete ? `，另有 ${r.skippedDelete} 条被其他资料引用，没有删` : ''}。`);
      await loadBackups();
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '恢复失败');
    }
    setBusy(false);
  }

  const instructionRows = (): string[][] => [['列名', '是否必填', '可选值 / 说明'], ['状态', '否', def.statuses.map((s) => s.label).join('、')], ...importable.map((f) => [f.label, f.required ? '是' : '否', f.options ? f.options.map((o) => o.label).join('、') : f.type === 'ref' ? '填对方资料的名称（要先建好，重名无法匹配）' : f.type === 'money' ? '元，最多两位小数' : f.type === 'date' ? 'YYYY-MM-DD' : f.type === 'phone' ? '手机号' : (f.help ?? '')])];
  const instructions = () => downloadText(`${def.label}-填写说明.csv`, toCsv(instructionRows()));

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label={`导入${def.label}`}>
        <div className="modal-head between">
          <strong>导入{def.label}</strong>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted">
            用 Excel（.xlsx）或 CSV 文件，第一行是表头（字段中文名，可加“状态”列）。{def.uniqueField ? '编号相同的会更新已有记录，其余新建。' : '都会按新记录创建。'}
            密码不支持导入（证件号、卡号可以）。选择文件后会先预览，全部通过才能确认。
          </p>
          <div className="toolbar-inline">
            <button type="button" className="secondary-button" onClick={() => downloadText(`${def.label}-导入模板.csv`, toCsv([['状态', ...importable.map((f) => f.label), ...extraHeaders]]))}>
              下载模板
            </button>
            <button type="button" className="secondary-button" onClick={() => void downloadXlsx(`${def.label}-导入模板.xlsx`, [['状态', ...importable.map((f) => f.label), ...extraHeaders]])}>下载 Excel 模板</button>
            <button type="button" className="secondary-button" onClick={instructions}>下载填写说明</button>
            <button type="button" className="secondary-button" onClick={() => void downloadXlsx(`${def.label}-填写说明.xlsx`, instructionRows())}>下载填写说明（Excel）</button>
            <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="选择 Excel 或 CSV 文件" onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
          {busy && <p className="muted">处理中…</p>}
          {restoreMsg && <div role="status" className="notice ok-notice">{restoreMsg}</div>}
          {backups.length > 0 && (
            <details>
              <summary>导入前自动备份（最近 {backups.length} 份，可一键恢复）</summary>
              <table className="data-table">
                <thead><tr><th>备份时间</th><th className="num">记录数</th><th /></tr></thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.id}>
                      <td>{new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false })}{b.restoredAt ? '（已恢复过）' : ''}</td>
                      <td className="num">{b.recordCount}</td>
                      <td><button type="button" className="link-button" disabled={busy} onClick={() => void restore(b)}>恢复到这一份</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {error && <div role="alert" className="notice error">{error}</div>}
          {preview && (
            <>
              <p>
                共 {preview.results.length} 行：新建 {preview.created}，更新 {preview.updated}，
                <strong className={preview.failed ? 'bad-text' : undefined}> 有问题 {preview.failed}</strong>
              </p>
              <div className="table-scroll preview-scroll">
                <table className="data-table">
                  <thead><tr><th>行</th><th>结果</th><th>说明</th></tr></thead>
                  <tbody>
                    {preview.results.filter((r) => r.action === 'error').concat(preview.results.filter((r) => r.action !== 'error').slice(0, 20)).map((r) => (
                      <tr key={r.line}>
                        <td>{r.line}</td>
                        <td>{r.action === 'error' ? <span className="pill bad">有问题</span> : r.action === 'create' ? <span className="pill ok">新建</span> : <span className="pill warn">更新</span>}</td>
                        <td>{r.errors.length ? r.errors.join('；') : r.title}{r.warnings?.length ? <small className="muted"> 提示：{r.warnings.join('；')}</small> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          {preview && preview.failed > 0 && preview.failed < preview.results.length && (
            <button type="button" className="secondary-button" disabled={busy} title="有问题的行跳过，其余照常导入" onClick={() => void commit(true)}>
              只导入没问题的 {preview.results.length - preview.failed} 行
            </button>
          )}
          <button type="button" className="primary-button" disabled={busy || !preview || preview.failed > 0} onClick={() => void commit()}>
            确认导入
          </button>
        </div>
      </div>
    </div>
  );
}
