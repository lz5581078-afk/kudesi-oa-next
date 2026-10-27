import { useState } from 'react';
import { ApiError } from '../../api/client';
import { orgApi, type StaffImportResult } from './orgApi';

const ACTION: Record<string, string> = { create: '新增', update: '修改', skip: '跳过', error: '有问题' };

/** 员工 CSV 导入：选文件 → 预检（不写入）→ 确认导入。新账号的初始密码只在导入完成后显示这一次。 */
export function StaffImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<StaffImportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true); setError('');
    try { const r = await orgApi.importStaff(csv, dryRun); setResult(r); if (r.error) setError(r.error); if (!dryRun) onDone(); }
    catch (e) { setError(e instanceof ApiError ? e.message : '导入失败'); }
    setBusy(false);
  };
  const created = result && !result.dryRun ? result.rows.filter((r) => r.initialPassword) : [];
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card wide" role="dialog" aria-label="导入员工">
        <div className="modal-head"><strong>导入员工（CSV）</strong></div>
        <div className="modal-body">
          <p className="muted">列：姓名、登录账号、部门、岗位、直属上级、职称、用工类型、计薪方式、月薪(元)、时薪(元)。按登录账号找人，只修改填了值的列；找不到的会新增（必须填登录账号）。状态列只用于导出，导入不改状态。可以先“导出”再改。</p>
          <input type="file" accept=".csv,text/csv" aria-label="选择 CSV 文件" onChange={async (e) => { const f = e.target.files?.[0]; setResult(null); setCsv(f ? await f.text() : ''); }} />
          {error && <div role="alert" className="notice error">{error}</div>}
          {result && !result.error && (
            <>
              <p>{result.dryRun ? '预检结果（还没有写入）' : '导入完成'}：新增 {result.summary.create}、修改 {result.summary.update}、跳过 {result.summary.skip}、有问题 {result.summary.error}</p>
              {created.length > 0 && (
                <div className="notice">新账号的初始密码只显示这一次，请当场抄给本人：
                  <ul>{created.map((r) => <li key={r.line}>{r.name}（{r.account}）：<code>{r.initialPassword}</code></li>)}</ul>
                </div>
              )}
              <table className="data-table"><thead><tr><th>行</th><th>姓名</th><th>账号</th><th>处理</th><th>说明</th></tr></thead>
                <tbody>{result.rows.map((r) => <tr key={r.line}><td>{r.line}</td><td>{r.name}</td><td>{r.account}</td><td>{ACTION[r.action]}</td><td>{r.message}</td></tr>)}</tbody></table>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
          <button type="button" className="secondary-button" disabled={!csv || busy} onClick={() => void run(true)}>预检</button>
          <button type="button" className="primary-button" disabled={!csv || busy || !result || !result.dryRun || !!result.error || result.summary.create + result.summary.update === 0} onClick={() => void run(false)}>确认导入</button>
        </div>
      </div>
    </div>
  );
}
