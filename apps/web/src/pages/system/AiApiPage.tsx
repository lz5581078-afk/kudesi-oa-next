import { useCallback, useEffect, useState } from 'react';
import { createChecker } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { aiApi, type AiModel, type AiProvider } from './aiApi';
import { SecretInput } from './SecretInput';

const STATUS: Record<string, [string, string]> = { active: ['启用', 'ok'], testing: ['测试中', 'warn'], inactive: ['已停用', ''] };
const err = (e: unknown, d: string) => (e instanceof ApiError ? e.message : d);
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-') : '从未同步');

/** AI API 接口：管理多个 AI 服务商（OpenAI 兼容）和模型清单。密钥只写不读；同步模型要管理员先打开“模型同步”开关（默认关）。 */
export function AiApiPage() {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  const canEdit = can('system.ai-api.edit');
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const [data, setData] = useState<{ syncEnabled: boolean; providers: AiProvider[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [edit, setEdit] = useState<{ id: number | null; form: { name: string; baseUrl: string; apiKey: string; modelName: string; status: string } } | null>(null);
  const [view, setView] = useState<AiProvider | null>(null);
  const [busy, setBusy] = useState<number | 'switch' | null>(null);
  const load = useCallback(() => { aiApi.overview().then((d) => { setData(d); setError(''); }).catch((e) => setError(err(e, '加载失败'))); }, []);
  useEffect(load, [load]);

  async function sync(p: AiProvider) {
    setBusy(p.id); setNotice(''); setError('');
    try { const r = await aiApi.sync(p.id); setNotice(`「${p.name}」已同步 ${r.synced} 个模型`); } catch (e) { setError(err(e, '同步失败')); }
    setBusy(null); load();
  }
  async function toggleSwitch() {
    if (!data) return;
    setBusy('switch');
    try { await aiApi.setSwitch(!data.syncEnabled); load(); } catch (e) { setError(err(e, '操作失败')); }
    setBusy(null);
  }

  return (
    <div>
      <div className="page-head"><h1>AI API 接口</h1>{canEdit && <button type="button" className="primary-button" onClick={() => setEdit({ id: null, form: { name: '', baseUrl: '', apiKey: '', modelName: '', status: 'active' } })}>添加服务商</button>}</div>
      <p className="muted">添加兼容 OpenAI 接口格式的 AI 服务商，同步它的模型清单；营业执照、快递价格表识别用哪个模型，在“OCR 设置”里选。API Key 加密保存，保存后不会再显示。</p>
      <div className="card settings-card">
        <div className="between"><strong>模型同步开关</strong><span className={`pill ${data?.syncEnabled ? 'ok' : ''}`}>{data?.syncEnabled ? '已打开' : '已关闭'}</span></div>
        <p className="muted">同步模型会连接服务商读取模型清单（只读）。开关默认关闭，关闭时点“同步模型”不会连接任何外部服务。</p>
        {isAdmin ? <button type="button" className="secondary-button" disabled={busy === 'switch' || !data} onClick={toggleSwitch}>{data?.syncEnabled ? '关闭模型同步' : '打开模型同步'}</button> : <span className="muted">只有公司管理员能改这个开关。</span>}
      </div>
      {notice && <div role="status" className="notice ok-notice">{notice}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="table-scroll"><table className="data-table stack-mobile">
        <thead><tr><th>服务商</th><th>接口地址</th><th>默认模型</th><th>模型数</th><th>状态</th><th>最近同步</th><th /></tr></thead>
        <tbody>
          {data?.providers.length === 0 && <tr><td colSpan={7} className="empty-state muted"><strong>还没有 AI 服务商</strong><span>点右上角“添加服务商”，填入接口地址和 API Key。</span></td></tr>}
          {data?.providers.map((p) => (
            <tr key={p.id}>
              <td className="cell-title"><strong>{p.name}</strong></td>
              <td data-label="接口地址">{p.baseUrl}</td>
              <td data-label="默认模型">{p.modelName ?? '—'}</td>
              <td data-label="模型数">{p.modelCount}</td>
              <td data-label="状态"><span className={`pill ${STATUS[p.status]?.[1] ?? ''}`}>{STATUS[p.status]?.[0] ?? p.status}</span></td>
              <td data-label="最近同步">{fmt(p.lastSyncedAt)}{p.lastSyncError && <span className="sub-line late-text">{p.lastSyncError}</span>}</td>
              <td className="row-actions">
                <button type="button" className="link-button" onClick={() => setView(p)}>查看模型</button>
                {canEdit && <>
                  <button type="button" className="secondary-button small" disabled={busy === p.id} onClick={() => sync(p)}>同步模型</button>
                  <button type="button" className="link-button" onClick={() => setEdit({ id: p.id, form: { name: p.name, baseUrl: p.baseUrl, apiKey: '', modelName: p.modelName ?? '', status: p.status } })}>修改</button>
                  <button type="button" className="link-button" onClick={() => { if (window.confirm(`删除「${p.name}」？它同步来的模型和识别默认模型设置会一并清除。`)) aiApi.remove(p.id).then(() => { setNotice('已删除'); load(); }).catch((e) => setError(err(e, '删除失败'))); }}>删除</button>
                </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {edit && <ProviderForm edit={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setNotice('已保存'); load(); }} />}
      {view && <ModelsDialog provider={view} onClose={() => setView(null)} />}
    </div>
  );
}

function ProviderForm({ edit, onClose, onSaved }: { edit: { id: number | null; form: { name: string; baseUrl: string; apiKey: string; modelName: string; status: string } }; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(edit.form);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const urlBad = f.baseUrl.trim() !== '' && !/^https?:\/\/[^\s/]+/i.test(f.baseUrl.trim());
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="AI 服务商" onSubmit={async (e) => {
        e.preventDefault(); setError('');
        if (!f.name.trim()) return setError('请填写服务商名称');
        if (!f.baseUrl.trim() || urlBad) return setError('接口地址要以 https:// 开头，例如 https://api.openai.com/v1');
        if (!edit.id && !f.apiKey.trim()) return setError('请填写 API Key');
        setBusy(true);
        const body = { name: f.name.trim(), baseUrl: f.baseUrl.trim(), apiKey: f.apiKey.trim() || undefined, modelName: f.modelName.trim() || undefined, status: f.status };
        try { await (edit.id ? aiApi.update(edit.id, body) : aiApi.create(body)); onSaved(); } catch (er) { setError(err(er, '保存失败')); setBusy(false); }
      }}>
        <div className="modal-head"><strong>{edit.id ? '修改服务商' : '添加服务商'}</strong></div>
        <div className="modal-body">
          <label>名称 *<input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>接口地址 *<input value={f.baseUrl} placeholder="https://api.openai.com/v1" aria-invalid={urlBad} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} /></label>
          <label>API Key{edit.id ? '' : ' *'}<SecretInput value={f.apiKey} placeholder={edit.id ? '已设置，留空表示不修改' : ''} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>
          <label>默认模型名（选填）<input value={f.modelName} maxLength={100} placeholder="如 gpt-4o" onChange={(e) => setF({ ...f, modelName: e.target.value })} /></label>
          <label>状态<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">启用</option><option value="testing">测试中</option><option value="inactive">停用</option></select></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>保存</button></div>
      </form>
    </div>
  );
}

const CAP: Record<string, string> = { text: '文字', vision: '看图', embedding: '向量', 'image-generation': '生成图片', 'video-generation': '生成视频' };

function ModelsDialog({ provider, onClose }: { provider: AiProvider; onClose: () => void }) {
  const [rows, setRows] = useState<AiModel[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { aiApi.models(provider.id).then(setRows).catch((e) => setError(err(e, '加载失败'))); }, [provider.id]);
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="模型清单">
        <div className="modal-head"><strong>{provider.name} 的模型</strong></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {rows?.length === 0 && <p className="muted">还没有同步过模型。打开“模型同步”开关后，点该服务商的“同步模型”。</p>}
          {rows && rows.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>模型</th><th>提供方</th><th>调用方式</th><th>能力</th></tr></thead>
            <tbody>{rows.map((m) => <tr key={m.modelId}><td>{m.modelId}</td><td>{m.ownedBy ?? ''}</td><td>{m.endpointType}</td><td>{m.capabilities.map((c) => CAP[c] ?? c).join('、')}</td></tr>)}</tbody></table></div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}
