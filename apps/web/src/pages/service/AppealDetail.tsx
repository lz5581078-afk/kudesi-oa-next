import { useCallback, useEffect, useState } from 'react';
import { APPEAL_RESULT_LABEL, appealTypeLabel } from '@kudesi/shared';
import { CopyButton } from '../../resources/CopyValue';
import { fmtTime } from '../flow/flowApi';
import { money } from '../finance/common';
import { CaseFiles, DetailModal, DueText, FlowStrip, FollowUps, StageTag, errText, useNow } from './CaseParts';
import { serviceApi, type AppealDetailDto } from './serviceApi';

/** 申诉详情：申诉内容、办理进度（复核→提交平台→登记结果）、举证凭证、跟进记录；被平台驳回的可以发起复议。 */
export function AppealDetail({ id, onClose, onChanged, onOpenOther, onReconsider }: { id: number; onClose: () => void; onChanged: () => void; onOpenOther: (id: number) => void; onReconsider: (a: AppealDetailDto) => void }) {
  const [d, setD] = useState<AppealDetailDto | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [key, setKey] = useState(0);
  const now = useNow();
  const load = useCallback(() => {
    setLoading(true);
    return serviceApi.apDetail(id).then((r) => { setD(r); setError(''); }).catch((e) => setError(errText(e, '加载失败'))).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { void load(); }, [load, key]);
  const changed = () => { setKey((k) => k + 1); onChanged(); };
  const urlOf = useCallback((fid: number) => serviceApi.apFileUrl(id, fid), [id]);

  if (!d) return <div className="modal-backdrop"><div className="modal card"><div className="modal-body">{error ? <div role="alert" className="notice error">{error}</div> : '加载中…'}<button type="button" className="secondary-button" onClick={onClose}>关闭</button></div></div></div>;
  const needEvidence = d.open && d.files.length === 0;
  return (
    <DetailModal label="订单申诉详情" title={<>{d.appealNo} · {appealTypeLabel(d.appealType)}</>} tags={<StageTag stage={d.stage} returned={d.returnedBack} />}
      sub={<>登记人 {d.createdByName} · {fmtTime(d.createdAt)}</>} onClose={onClose} onRefresh={() => setKey((k) => k + 1)} refreshing={loading}>
      {error && <div role="alert" className="notice error">{error}</div>}
      {d.overdue && <div role="alert" className="notice error">这条申诉已经超时，已进入“兜底监督”{d.deadlineAt ? `（平台截止 ${fmtTime(d.deadlineAt).slice(0, 10)}）` : ''}。申诉失败次数不限，但要尽快办理。</div>}
      {d.result && <div className={`result-banner ${d.result === 'approved' ? 'ok' : 'bad'}`} role="status">{APPEAL_RESULT_LABEL[d.result]}{d.resultNote ? `：${d.resultNote}` : ''}</div>}
      <section>
        <h3 className="section-title">申诉内容</h3>
        <dl className="kv-grid">
          <div><dt>订单号</dt><dd className="mono">{d.orderNo} <CopyButton value={d.orderNo} label="订单号" /></dd></div>
          <div><dt>申诉编号</dt><dd className="mono">{d.appealNo} <CopyButton value={d.appealNo} label="申诉编号" /></dd></div>
          <div><dt>店铺</dt><dd>{d.storeName}</dd></div>
          <div><dt>申诉类型</dt><dd>{appealTypeLabel(d.appealType)}</dd></div>
          <div><dt>涉及金额</dt><dd>{money(d.amountCents)}</dd></div>
          <div><dt>平台倒计时</dt><dd>{d.deadlineAt ? fmtTime(d.deadlineAt).slice(0, 10) : '未填'}</dd></div>
          <div><dt>当前环节</dt><dd>{d.open ? <>{d.stepName} · <DueText dueAt={d.dueAt} open={d.open} now={now} /></> : '已办结'}</dd></div>
          <div><dt>当前办理人</dt><dd>{d.open ? d.handlers.join('、') || '—' : '—'}</dd></div>
          {d.platformAppealNo && <div><dt>平台申诉单号</dt><dd className="mono">{d.platformAppealNo} <CopyButton value={d.platformAppealNo} label="平台申诉单号" /></dd></div>}
          {d.submittedAt && <div><dt>提交平台日期</dt><dd>{d.submittedAt.slice(0, 10)}</dd></div>}
          <div className="wide"><dt>申诉理由</dt><dd>{d.reason}</dd></div>
        </dl>
        {d.canReconsider && <div className="row-actions"><button type="button" className="primary-button" onClick={() => onReconsider(d)}>对这条申诉发起复议</button><span className="muted">平台驳回后可以补充新的凭证再申诉，次数不限</span></div>}
        {d.sameOrder.length > 0 && (
          <div className="notice warn">
            同一订单还有 {d.sameOrder.length} 条申诉记录：
            {d.sameOrder.map((o) => <button key={o.id} type="button" className="link-button" onClick={() => onOpenOther(o.id)}> {o.appealNo}（{appealTypeLabel(o.appealType)}）</button>)}
          </div>
        )}
      </section>
      {needEvidence && <div role="status" className="notice warn">还没有举证凭证：复核和提交平台前都必须先上传有效凭证（聊天记录、发货/物流凭证、商品照片等）。</div>}
      <FlowStrip runId={d.runId} refreshKey={key} onChanged={changed} />
      <CaseFiles files={d.files} editable={d.open} urlOf={urlOf} title="举证凭证" hint="还没有凭证。可以点“上传”选择、把图片拖进来，或直接 Ctrl+V 粘贴截图。"
        onAdd={async (f) => { await serviceApi.apUpload(id, f); changed(); }} onRemove={async (fid) => { await serviceApi.apRemoveFile(id, fid); changed(); }} />
      <FollowUps logs={d.logs} canWrite canUrge={d.open} onAdd={async (c, k) => { await serviceApi.apLog(id, c, k); changed(); }} />
    </DetailModal>
  );
}
