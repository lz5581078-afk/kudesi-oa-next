import { useEffect, useState } from 'react';
import { liveApi, type Options, type ManualBody } from './liveApi';
import { errText, nowText, yuanCents } from './liveFormat';
import { TrialPersonDialog } from './TrialPersonDialog';
export function ManualReportsTab({ onOpen }: { onOpen: (id: number) => void }) {
  const [opts, setOpts] = useState<Options | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [trial, setTrial] = useState(false),
    [saved, setSaved] = useState<number | null>(null);
  const [f, setF] = useState({
    sessionId: '',
    roomId: '',
    anchorId: '',
    controlId: '',
    operatorId: '',
    douyinAccountId: '',
    storeId: '',
    startAt: nowText(),
    endAt: nowText(),
    sales: '',
    controlSales: '',
    operatorSales: '',
    ad: '0',
    reason: '',
    orders: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setSaved(null);
    setF((v) => ({ ...v, [k]: e.target.value }));
  };
  useEffect(() => {
    liveApi
      .options()
      .then(setOpts)
      .catch((e) => setError(errText(e)));
  }, []);
  async function loadSession() {
    if (!f.sessionId) return;
    setError('');
    try {
      const s = await liveApi.session(Number(f.sessionId));
      setF((v) => ({
        ...v,
        roomId: String(s.roomId),
        anchorId: String(s.anchor.id),
        controlId: String(s.control?.id ?? ''),
        operatorId: String(s.operator?.id ?? ''),
        douyinAccountId: String(s.douyinAccount.id),
        storeId: String(s.store?.id ?? ''),
        startAt: s.startAt.slice(0, 16),
        endAt: s.endAt?.slice(0, 16) ?? nowText(),
        sales: String((s.reports[0]?.salesCents ?? 0) / 100),
        ad: String((s.reports.find((r) => r.role === 'control')?.adSpendCents ?? 0) / 100),
      }));
    } catch (e) {
      setError(errText(e));
    }
  }
  async function save() {
    setError('');
    const sales = yuanCents(f.sales),
      ad = yuanCents(f.ad),
      controlSales = yuanCents(f.controlSales),
      operatorSales = yuanCents(f.operatorSales);
    if (
      (f.controlSales && !Number.isSafeInteger(controlSales)) ||
      (f.operatorSales && !Number.isSafeInteger(operatorSales))
    )
      return setError('各角色销售额须为有效金额');
    if (
      !f.roomId ||
      !f.anchorId ||
      !f.douyinAccountId ||
      !f.storeId ||
      sales === null ||
      ad === null ||
      !Number.isSafeInteger(sales) ||
      !Number.isSafeInteger(ad) ||
      !f.reason.trim()
    )
      return setError('请完整填写房间、人员、账号、店铺、金额及特殊原因');
    setBusy(true);
    try {
      const body: ManualBody = {
        sessionId: f.sessionId ? Number(f.sessionId) : undefined,
        roomId: Number(f.roomId),
        anchorId: Number(f.anchorId),
        controlId: f.controlId ? Number(f.controlId) : null,
        operatorId: f.operatorId ? Number(f.operatorId) : null,
        douyinAccountId: Number(f.douyinAccountId),
        storeId: Number(f.storeId),
        startAt: f.startAt.replace('T', ' ') + ':00',
        endAt: f.endAt.replace('T', ' ') + ':00',
        salesCents: sales,
        adSpendCents: ad,
        controlSalesCents: controlSales ?? undefined,
        operatorSalesCents: operatorSales ?? undefined,
        reason: f.reason.trim(),
        orderIds: f.orders.split(/[\s,，]+/).filter(Boolean),
      };
      const r = await liveApi.manualReport(body);
      setSaved(r.id);
      setF((v) => ({ ...v, sessionId: String(r.id) }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  const select = (
    key: 'roomId' | 'anchorId' | 'controlId' | 'operatorId' | 'douyinAccountId' | 'storeId',
    label: string,
    rows: Array<{ id: number; name: string; trial?: boolean }>,
  ) => (
    <label className="live-field">
      {label}
      <select aria-label={label} value={f[key]} onChange={set(key)}>
        <option value="">请选择</option>
        {rows.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.trial ? '（试播）' : ''}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="card live-section">
      <h2>人事手工业绩填报</h2>
      <div className="pad live-page">
        <p className="notice warn">
          用于试播、漏报或接口异常。保存后仍需提交场次审核，审核时确认主播和中控时薪。无订单的手工业绩会在工资结算报表中标记为“特殊核定，未核对订单”。
        </p>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {saved && (
          <div role="status" className="notice ok">
            已保存场次 #{saved}，待提交审核。
            <button className="link-button" onClick={() => onOpen(saved)}>
              查看并提交审核
            </button>
          </div>
        )}
        <div className="live-fields">
          <label className="live-field">
            已有场次编号（补报时填写）
            <input aria-label="补报场次编号" inputMode="numeric" value={f.sessionId} onChange={set('sessionId')} />
            <button className="link-button" onClick={() => void loadSession()}>
              载入原场次
            </button>
          </label>
        </div>
        {opts && (
          <>
            <fieldset>
              <legend>房间与参与人员</legend>
              <div className="live-fields">
                {select('roomId', '直播间', opts.rooms)}
                {select('anchorId', '主播', opts.anchors)}
                {select('controlId', '中控（可选）', opts.controls)}
                {select('operatorId', '运营（可选）', opts.operators)}
                <button className="secondary-button" onClick={() => setTrial(true)}>
                  新增试播主播
                </button>
              </div>
            </fieldset>
            <fieldset>
              <legend>场次与业绩</legend>
              <div className="live-fields">
                {select('douyinAccountId', '抖音号', opts.douyinAccounts)}
                {select('storeId', '店铺', opts.stores)}
                <label className="live-field">
                  上播时间（北京时间）
                  <input
                    type="datetime-local"
                    aria-label="补报上播时间"
                    value={f.startAt.replace(' ', 'T')}
                    onChange={set('startAt')}
                  />
                </label>
                <label className="live-field">
                  下播时间（北京时间）
                  <input
                    type="datetime-local"
                    aria-label="补报下播时间"
                    value={f.endAt.replace(' ', 'T')}
                    onChange={set('endAt')}
                  />
                </label>
                <label className="live-field">
                  销售额（元）
                  <input aria-label="补报销售额" inputMode="decimal" value={f.sales} onChange={set('sales')} />
                </label>
                {f.controlId && (
                  <label className="live-field">
                    中控销售额（元，空则同主播）
                    <input
                      aria-label="补报中控销售额"
                      inputMode="decimal"
                      value={f.controlSales}
                      onChange={set('controlSales')}
                    />
                  </label>
                )}
                {f.operatorId && (
                  <label className="live-field">
                    运营销售额（元，空则同主播）
                    <input
                      aria-label="补报运营销售额"
                      inputMode="decimal"
                      value={f.operatorSales}
                      onChange={set('operatorSales')}
                    />
                  </label>
                )}
                <label className="live-field">
                  投流费用（元）
                  <input aria-label="补报投流" inputMode="decimal" value={f.ad} onChange={set('ad')} />
                </label>
                <label className="live-field wide">
                  本场订单号（可选，多条用空格或逗号分隔）
                  <textarea aria-label="补报订单号" rows={3} value={f.orders} onChange={set('orders')} />
                </label>
                <label className="live-field wide">
                  特殊原因（必填）
                  <textarea aria-label="补报原因" maxLength={500} rows={3} value={f.reason} onChange={set('reason')} />
                </label>
              </div>
            </fieldset>
          </>
        )}
        <div className="live-actions">
          <button className="primary-button" disabled={busy || !opts || saved !== null} onClick={() => void save()}>
            {busy ? '保存中…' : '保存为待审核场次'}
          </button>
        </div>
      </div>
      {trial && (
        <TrialPersonDialog
          onClose={() => setTrial(false)}
          onDone={(p) => {
            setTrial(false);
            setF((f) => ({ ...f, anchorId: String(p.id) }));
            liveApi
              .options()
              .then(setOpts)
              .catch((e) => setError(errText(e)));
          }}
        />
      )}
    </section>
  );
}
