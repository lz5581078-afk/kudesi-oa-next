import { useCallback, useEffect, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { ReasonDialog, RecordForm } from '../../../resources/RecordForm';
import { useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { money } from '../common';
import { expressApi, type TreeBranch, type TreeCarrier, type TreeVersion, type VersionDetail } from './expressApi';
import { PriceMatrixEditor } from './PriceMatrixEditor';
import { RecognizeDialog } from './RecognizeDialog';

const COOP = [['pending', '待确认'], ['active', '合作中'], ['paused', '已暂停']] as const;
const CHARGE: Record<string, string> = { fixed: '固定金额', percent: '按比例', per_kg: '按公斤' };
const err = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

type SubTab = 'final' | 'price' | 'surcharge' | 'info';

/** 一个价格版本的全部内容：合作状态、价格矩阵（AI/手工两套）、临时加收、合作备注。 */
export function VersionPanel({ carrier, branch, version, onChanged, onDeleted }: { carrier: TreeCarrier; branch: TreeBranch; version: TreeVersion; onChanged: () => void; onDeleted: () => void }) {
  const canPrice = useResourceCan('finance-express-prices');
  const [tab, setTab] = useState<SubTab>('final');
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [source, setSource] = useState<'ai' | 'manual'>('manual');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [recognize, setRecognize] = useState<'price' | 'surcharge' | null>(null);
  const [surchargeForm, setSurchargeForm] = useState<{ id: number | null } | null>(null);
  const [batchDelete, setBatchDelete] = useState<number | null>(null);
  const [ruleForm,setRuleForm] = useState<ResourceDto | null>(null);
  const [ruleDelete,setRuleDelete] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await expressApi.version(version.id);
      setDetail(d);
      setError('');
    } catch (e) { setError(err(e)); }
  }, [version.id]);
  useEffect(() => { setDetail(null); setNotice(''); void load(); }, [load]);
  useEffect(() => { if (detail) setSource(detail.effectiveSource); }, [detail?.version.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { void load(); onChanged(); };
  async function run(fn: () => Promise<unknown>, done?: string) {
    setError(''); setNotice('');
    try { await fn(); if (done) setNotice(done); refresh(); } catch (e) { setError(err(e)); }
  }

  const rules = detail?.rules.filter((r) => r.source === source) ?? [];
  const aiCount = detail?.rules.filter((r) => r.source === 'ai').length ?? 0;
  const manualCount = (detail?.rules.length ?? 0) - aiCount;
  const data = detail?.version.data ?? {};
  const remark = String(data.remark ?? '');

  return (
    <div className="version-panel">
      <div className="page-head between">
        <h2>{carrier.name} / {branch.name} / {version.name}</h2>
        <div className="toolbar">
          {version.inUse ? <span className="chip ok">正在参与运费预估</span> : <span className="chip muted">暂不参与运费预估</span>}
          {version.isCurrent ? <span className="chip active">当前版本</span> : canPrice('edit') && <button type="button" className="secondary-button small" onClick={() => void run(() => resourceApi.update('finance-express-branches', branch.id, { currentVersionId: version.id }), '已设为这个网点的当前版本')}>设为当前版本</button>}
        </div>
      </div>
      {!version.inUse && (
        <p className="muted">
          {!version.isCurrent ? '它不是网点的当前版本；' : ''}{version.cooperationStatus !== 'active' ? '合作状态不是“合作中”；' : ''}{version.status === 'inactive' ? '版本已停用；' : ''}运费预估和分区建议只读取“当前版本 + 合作中 + 日期有效”的价格。
        </p>
      )}
      <div className="toolbar">
        <label>合作状态 <select aria-label="合作状态" disabled={!canPrice('edit')} value={version.cooperationStatus} onChange={(e) => void run(() => resourceApi.update('finance-express-versions', version.id, { cooperationStatus: e.target.value }), '合作状态已更新')}>{COOP.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <span className="muted">有效期：{version.effectiveStart || '不限'} ~ {version.effectiveEnd || '长期'}；可发货 {version.shippingWeightMin ?? 0} ~ {version.shippingWeightMax ?? '不限'} kg</span>
        {canPrice('edit') && <button type="button" className="secondary-button small" onClick={() => setEditing(true)}>修改版本信息</button>}
        {canPrice('delete') && <button type="button" className="secondary-button small danger" onClick={() => setDeleting(true)}>删除版本</button>}
      </div>
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}

      <div className="tab-group" role="tablist" aria-label="版本内容">
        {([['final', '最终价格'], ['price', '原始 / 手工价格'], ['surcharge', `临时加收（${detail?.surcharges.length ?? version.surchargeCount}）`], ['info', '合作备注与识别记录']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'chip active' : 'chip'} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {!detail && !error && <p className="muted">加载中…</p>}
      {detail && tab === 'final' && <section className="card" aria-label="最终价格表">
        <div className="toolbar"><label>最终价格依据<select aria-label="最终价格依据" disabled={!canPrice('edit')} value={String(data.priceSource ?? '')} onChange={e=>void run(()=>resourceApi.update('finance-express-versions',version.id,{priceSource:e.target.value || null}),'最终价格依据已更新')}><option value="">自动（有手工用手工）</option><option value="ai">AI 识别价格表</option><option value="manual">手工价格表</option></select></label>
          <button type="button" className="secondary-button" onClick={()=>{setSource('ai');setTab('price');}}>查看原始价格表</button>
          {canPrice('edit') && <><button type="button" className="secondary-button" onClick={()=>{setSource('manual');setTab('price');}}>手工维护价格</button><button type="button" className="secondary-button" onClick={()=>setRecognize('price')}>上传价格表识别</button><button type="button" className="secondary-button" onClick={()=>setRecognize('surcharge')}>上传加收通知识别</button></>}
        </div><p className="muted">当前采用{detail.effectiveSource==='ai'?'AI识别价格表':'手工价格表'}，临时加收在对应页签维护。</p>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>省份</th><th>重量范围（kg）</th><th>计价方式</th><th>固定价 / 首重价</th><th>续重价</th><th>操作</th></tr></thead><tbody>
          {detail.rules.filter(r=>r.source===detail.effectiveSource).map(r=><tr key={r.id}><td>{r.province}</td><td>{r.minExclusive?'＞':'≥'}{r.shipWeightMin ?? 0}，{r.shipWeightMax == null?'不限':`${r.maxExclusive?'＜':'≤'}${r.shipWeightMax}`}</td><td>{r.fixedPrice != null?'区间统一价':`首重 ${r.firstWeight ?? 1}kg / 续重`}</td><td>{money(r.fixedPrice ?? r.firstPrice)}</td><td>{r.fixedPrice != null?'—':money(r.extraPrice)}</td><td className="row-actions">{canPrice('edit') && <button type="button" className="link-button" onClick={()=>void run(async()=>setRuleForm(await resourceApi.get('finance-express-prices',r.id)))}>修改</button>}{canPrice('delete') && <button type="button" className="link-button danger" onClick={()=>setRuleDelete(r.id)}>删除</button>}</td></tr>)}
          {!detail.rules.some(r=>r.source===detail.effectiveSource) && <tr><td colSpan={6} className="empty-state muted">该版本还没有当前采用的价格规则。</td></tr>}
        </tbody></table></div>
      </section>}
      {detail && tab === 'price' && (
        <div>
          <div className="toolbar">
            <span>价格来源：</span>
            <button type="button" className={source === 'ai' ? 'chip active' : 'chip'} onClick={() => setSource('ai')}>AI 识别价格表（{aiCount}）</button>
            <button type="button" className={source === 'manual' ? 'chip active' : 'chip'} onClick={() => setSource('manual')}>手工价格表（{manualCount}）</button>
            <label>最终价格依据 <select aria-label="最终价格依据" disabled={!canPrice('edit')} value={String(data.priceSource ?? '')} onChange={(e) => void run(() => resourceApi.update('finance-express-versions', version.id, { priceSource: e.target.value || null }), '最终价格依据已更新')}>
              <option value="">自动（有手工用手工）</option><option value="ai">AI 识别价格表</option><option value="manual">手工价格表</option></select></label>
            {canPrice('edit') && <button type="button" className="secondary-button" onClick={() => setRecognize('price')}>AI 识别价格表</button>}
          </div>
          <p className="muted">现在实际生效的是：{detail.effectiveSource === 'ai' ? 'AI 识别价格表' : '手工价格表'}。两套价格可以并存，只有“最终价格依据”选中的那一套参与运费预估。</p>
          <PriceMatrixEditor versionId={version.id} source={source} rules={rules} canEdit={canPrice('edit')} onSaved={refresh} />
        </div>
      )}

      {detail && tab === 'surcharge' && (
        <div>
          <div className="toolbar">
            {canPrice('edit') && <button type="button" className="primary-button" onClick={() => setSurchargeForm({ id: null })}>手工新增加收</button>}
            {canPrice('edit') && <button type="button" className="secondary-button" onClick={() => setRecognize('surcharge')}>AI 识别加收通知</button>}
          </div>
          <p className="muted">临时加收只做记录和查询，不计入运费预估和分区建议。</p>
          {detail.batches.length === 0 && detail.surcharges.length === 0 && <p className="muted">这个版本还没有加收通知。</p>}
          {detail.batches.map((b) => (
            <div key={b.id} className="card">
              <div className="between"><strong>{b.batchName}</strong>
                <span className="row-actions">
                  <span className={b.status === 'active' ? 'chip ok' : 'chip muted'}>{b.status === 'active' ? '已生效' : '已停用'}</span>
                  {b.evidence?.[0] ? <button type="button" className="secondary-button small" onClick={() => void resourceApi.fileUrl(b.evidence![0]).then((r) => window.open(r.url, '_blank', 'noopener')).catch(() => undefined)}>查看原始凭据</button> : null}
                  {canPrice('edit') && <button type="button" className="secondary-button small" onClick={() => void run(() => b.status === 'active' ? resourceApi.changeStatus('finance-express-fee-batches', b.id, 'stopped', '通知已过期或作废') : resourceApi.changeStatus('finance-express-fee-batches', b.id, 'active'))}>{b.status === 'active' ? '停用整批' : '恢复整批'}</button>}
                  {canPrice('delete') && <button type="button" className="secondary-button small danger" onClick={() => setBatchDelete(b.id)}>删除整批</button>}
                </span></div>
              <p className="muted">{b.source === 'ai' ? 'AI 识别' : '手工'}{b.fileName ? `，文件：${b.fileName}` : ''}</p>
              <SurchargeTable rows={detail.surcharges.filter((s) => s.batchId === b.id)} canEdit={canPrice('edit')} onEdit={(id) => setSurchargeForm({ id })} />
            </div>
          ))}
          {detail.surcharges.some((s) => !s.batchId) && (
            <div className="card"><strong>未归入批次</strong><SurchargeTable rows={detail.surcharges.filter((s) => !s.batchId)} canEdit={canPrice('edit')} onEdit={(id) => setSurchargeForm({ id })} /></div>
          )}
        </div>
      )}

      {detail && tab === 'info' && (
        <div>
          <h3>合作备注</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{remark || <span className="muted">没有备注。合作内容、退改费、其他费用和特殊口径可以写在这里（点“修改版本信息”）。</span>}</p>
          {data.attachmentName ? <p>原始价格表：{String(data.attachmentName)}</p> : null}
          <h3>识别记录</h3>
          {detail.recognitions.length === 0 ? <p className="muted">还没有识别过。</p> : (
            <table className="data-table"><thead><tr><th>时间</th><th>类型</th><th>文件</th><th>模型</th><th>结果</th></tr></thead><tbody>
              {detail.recognitions.map((r) => <tr key={r.id}><td>{r.createdAtKey ? new Date(r.createdAtKey).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'}</td><td>{r.recognitionType === 'price_table' ? '价格表' : '加收通知'}</td><td>{r.fileName || '—'}</td><td>{r.modelName || '—'}</td><td>{r.resultText}</td></tr>)}
            </tbody></table>
          )}
        </div>
      )}

      {editing && <RecordForm def={getResourceDef('finance-express-versions')!} record={versionRecord(detail, version)} lockedFields={['branchId']} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {surchargeForm && (
        <SurchargeFormHost id={surchargeForm.id} versionId={version.id} onClose={() => setSurchargeForm(null)} onSaved={() => { setSurchargeForm(null); refresh(); }} />
      )}
      {recognize && <RecognizeDialog versionId={version.id} kind={recognize} onClose={() => setRecognize(null)} onDone={(m) => { setRecognize(null); setNotice(m); refresh(); }} />}
      {deleting && (
        <ReasonDialog title={`删除价格版本「${version.name}」`} hint={`会连同它的 ${version.aiRuleCount + version.manualRuleCount} 条价格规则、加收和识别记录一起删除，不能恢复。`} confirmLabel="确认删除" danger onClose={() => setDeleting(false)}
          onConfirm={async (reason) => { await expressApi.remove('versions', version.id, reason); setDeleting(false); onDeleted(); }} />
      )}
      {batchDelete !== null && (
        <ReasonDialog title="删除整批加收通知" hint="批次下的所有加收规则会一起删除，不能恢复。" confirmLabel="确认删除" danger onClose={() => setBatchDelete(null)}
          onConfirm={async (reason) => { await expressApi.remove('surcharge-batches', batchDelete, reason); setBatchDelete(null); refresh(); }} />
      )}
      {ruleForm && <RecordForm def={getResourceDef('finance-express-prices')!} record={ruleForm} initial={ruleForm.data} lockedFields={['versionId','source']} onClose={()=>setRuleForm(null)} onSaved={()=>{setRuleForm(null);refresh();}}/>}
      {ruleDelete !== null && <ReasonDialog title="删除价格规则" confirmLabel="确认删除" danger onClose={()=>setRuleDelete(null)} onConfirm={async reason=>{await resourceApi.remove('finance-express-prices',ruleDelete,reason);setRuleDelete(null);refresh();}}/>}
    </div>
  );
}

/** RecordForm 需要完整的记录对象；详情接口里已有字段，拼一个即可 */
function versionRecord(detail: VersionDetail | null, v: TreeVersion) {
  if (!detail) return null;
  return { id: v.id, type: 'finance-express-versions', title: v.name, status: v.status, statusReason: null, data: detail.version.data, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' };
}

function SurchargeTable({ rows, canEdit, onEdit }: { rows: VersionDetail['surcharges']; canEdit: boolean; onEdit: (id: number) => void }) {
  if (!rows.length) return <p className="muted">这个批次下没有规则。</p>;
  return (
    <div className="table-scroll"><table className="data-table">
      <thead><tr><th>名称</th><th>省份</th><th>日期</th><th>加收</th><th>重量范围</th><th>状态</th>{canEdit && <th />}</tr></thead>
      <tbody>{rows.map((s) => (
        <tr key={s.id}><td>{s.name}</td><td>{s.areaScope || '—'}</td><td>{s.effectiveStart || '—'} ~ {s.effectiveEnd || '长期'}</td>
          <td>{CHARGE[s.chargeType]} {s.chargeType === 'percent' ? `${s.percent ?? '—'}%` : money(s.amount)}{s.chargeType === 'per_kg' ? '/kg' : ''}</td>
          <td>{s.weightMode === 'below' ? `${s.weightEnd}kg 以内` : s.weightMode === 'above' ? `${s.weightStart}kg 以上` : s.weightMode === 'between' ? `${s.weightStart}~${s.weightEnd}kg` : '全部重量'}</td>
          <td>{s.status === 'active' ? '启用' : '停用'}</td>{canEdit && <td><button type="button" className="link-button" onClick={() => onEdit(s.id)}>修改</button></td>}</tr>
      ))}</tbody>
    </table></div>
  );
}

function SurchargeFormHost({ id, versionId, onClose, onSaved }: { id: number | null; versionId: number; onClose: () => void; onSaved: () => void }) {
  const [record, setRecord] = useState<Awaited<ReturnType<typeof resourceApi.get>> | null | undefined>(id === null ? null : undefined);
  useEffect(() => { if (id !== null) void resourceApi.get('finance-express-surcharges', id).then(setRecord).catch(() => onClose()); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (record === undefined) return null;
  return <RecordForm def={getResourceDef('finance-express-surcharges')!} record={record} initial={{ versionId }} lockedFields={['versionId']} onClose={onClose} onSaved={onSaved} />;
}
