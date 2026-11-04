import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { todayInChina } from '@kudesi/shared';
import { ReasonDialog } from '../../../resources/RecordForm';
import { useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi } from '../../../resources/api';
import { money } from '../common';
import { QueryPanel, QueryTable, type Col } from '../query/QueryKit';
import { expressApi, type BatchRow, type RuleRow, type SurchargeRow, type TreeBranch, type TreeCarrier, type TreeVersion, type VersionDetail } from './expressApi';
import { HierarchyForm } from './HierarchyForm';
import { ManualPriceDialog } from './ManualPriceDialog';
import { PriceRuleDialog } from './PriceRuleDialog';
import { RecognizeDialog } from './RecognizeDialog';
import { SurchargeDialog } from './SurchargeDialog';
import './versionPanel.css';

const COOP = { pending: '待确认', active: '合作中', paused: '已暂停' } as const;
const CHARGE = { fixed: '固定金额', percent: '按比例', per_kg: '按公斤' };
const when = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-';
const weight = (row: RuleRow) => `${row.minExclusive ? '>' : '≥'}${row.shipWeightMin ?? 0}kg${row.shipWeightMax == null ? '以上' : ` 且 ${row.maxExclusive ? '<' : '≤'}${row.shipWeightMax}kg`}${row.fixedPrice == null ? `（首重${row.firstWeight ?? 1}kg）` : ''}`;
const surchargeWeight = (row: SurchargeRow) => row.weightMode === 'below' ? `${row.weightEnd}kg以内` : row.weightMode === 'above' ? `${row.weightStart}kg以上` : row.weightMode === 'between' ? `${row.weightStart}–${row.weightEnd}kg` : '全重量段';
type Rule = RuleRow & { id: number; source: string };
type Action = { kind: 'rule-delete' | 'batch-stop' | 'batch-delete' | 'surcharge-stop' | 'surcharge-delete'; id: number; name: string };
const recognitionName = (kind: string) => ({ price_table: '价格表识别', surcharge_notice: '加收通知识别', manual_price: '手工创建价格表', manual_surcharge: '手工新增加收' }[kind] || kind);

/** Version content follows the original page: base quotations, configuration, batches and cooperation notes. */
export function VersionPanel({ carrier, branch, version, onChanged, onBack }: { carrier: TreeCarrier; branch: TreeBranch; version: TreeVersion; onChanged: () => void; onDeleted?: () => void; onBack?: () => void }) {
  const can = useResourceCan('finance-express-prices');
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false), [manual, setManual] = useState(false), [surcharge, setSurcharge] = useState(false);
  const [recognize, setRecognize] = useState<'price' | 'surcharge' | null>(null);
  const [rule, setRule] = useState<Rule | null>(null), [action, setAction] = useState<Action | null>(null);
  const [info, setInfo] = useState<{ title: string; content: ReactNode } | null>(null);
  const [remark, setRemark] = useState(''), [remarkDirty, setRemarkDirty] = useState(false);
  const remarkRef = useRef(''), dirtyRemarkRef = useRef(false), savingRemark = useRef(false);
  const load = useCallback(async () => {
    try { const result = await expressApi.version(version.id); setDetail(result); setError(''); }
    catch (e) { setError((e as Error).message || '读取失败'); }
  }, [version.id]);
  useEffect(() => { setDetail(null); void load(); }, [load]);
  useEffect(() => { if (detail && !remarkDirty) { const value = String(detail.version.data.remark ?? ''); setRemark(value); remarkRef.current = value; } }, [detail, remarkDirty]);
  const refresh = () => { void load(); onChanged(); };
  async function run(operation: () => Promise<unknown>, message?: string) {
    setError(''); setNotice('');
    try { await operation(); if (message) setNotice(message); refresh(); }
    catch (e) { setError((e as Error).message || '操作失败'); }
  }
  async function saveRemark() {
    if (!dirtyRemarkRef.current || savingRemark.current || !can('edit')) return;
    savingRemark.current = true;
    const value = remarkRef.current;
    let saved = false;
    try {
      await resourceApi.update('finance-express-versions', version.id, { remark: value });
      setDetail(current => current ? { ...current, version: { ...current.version, data: { ...current.version.data, remark: value } } } : current);
      if (remarkRef.current === value) { dirtyRemarkRef.current = false; setRemarkDirty(false); }
      onChanged(); saved = true;
    } catch (e) { setError((e as Error).message || '备注保存失败'); }
    finally { savingRemark.current = false; }
    if (saved && dirtyRemarkRef.current && remarkRef.current !== value) void saveRemark();
  }
  const data = detail?.version.data ?? {};
  const rules = detail?.rules.filter(row => row.source === detail.effectiveSource).sort((a, b) => (a.shipWeightMax ?? Infinity) - (b.shipWeightMax ?? Infinity) || (a.shipWeightMin ?? 0) - (b.shipWeightMin ?? 0) || a.id - b.id) ?? [];
  const ruleColumns: Col<Rule>[] = [
    { key: 'date', head: '查询日期', cell: () => todayInChina(), csv: () => todayInChina() },
    { key: 'province', head: '省份', cell: row => row.province === 'ALL' ? '全国' : row.province, csv: row => row.province },
    { key: 'weight', head: '重量', cell: weight, csv: weight, sortValue: row => row.shipWeightMax ?? Infinity },
    { key: 'amount', head: '基础运费', cell: row => money(row.fixedPrice ?? row.firstPrice), csv: row => row.fixedPrice ?? row.firstPrice },
    { key: 'version', head: '使用版本', cell: () => version.name, csv: () => version.name },
    { key: 'description', head: '规则说明', cell: row => row.fixedPrice == null ? '首重续重公式' : '基础价格规则', csv: row => row.fixedPrice == null ? '首重续重公式' : '基础价格规则' },
    { key: 'actions', head: '操作', action: true, cell: row => <div className="row-actions">{can('edit') && <button type="button" className="secondary-button small" aria-label={`修改 ${row.province} ${weight(row)}`} onClick={() => setRule(row)}>修改</button>}{can('delete') && <button type="button" className="secondary-button small danger" aria-label={`删除 ${row.province} ${weight(row)}`} onClick={() => setAction({ kind: 'rule-delete', id: row.id, name: `${row.province} ${weight(row)}` })}>删除</button>}</div> },
  ];
  const recordsColumns: Col<VersionDetail['recognitions'][number]>[] = [
    { key: 'time', head: '时间', cell: row => when(row.createdAtKey), csv: row => row.createdAtKey }, { key: 'type', head: '类型', cell: row => recognitionName(row.recognitionType), csv: row => recognitionName(row.recognitionType) },
    { key: 'file', head: '文件/凭据', cell: row => row.fileName || '-', csv: row => row.fileName }, { key: 'model', head: '模型/来源', cell: row => row.modelName || '-', csv: row => row.modelName },
    { key: 'status', head: '状态', cell: row => row.recognitionType === 'manual_surcharge' ? '已生效' : '已确认导入', csv: row => row.status }, { key: 'count', head: '结果数', cell: row => row.resultCount ?? row.resultText ?? 0, csv: row => row.resultCount ?? row.resultText },
  ];
  async function evidence(batch: BatchRow) {
    if (batch.evidence?.[0]) { try { const result = await resourceApi.fileUrl(batch.evidence[0]); window.open(result.url, '_blank', 'noopener'); } catch (e) { setError((e as Error).message || '凭据读取失败'); } }
    else setInfo({ title: '原始凭据', content: <p>{batch.fileName ? `当前只保存了文件名：${batch.fileName}` : '暂无原始凭据'}</p> });
  }
  async function confirmAction() {
    if (!action) return;
    if (action.kind === 'rule-delete') await resourceApi.remove('finance-express-prices', action.id, '人工确认删除价格规则');
    if (action.kind === 'batch-delete') await expressApi.remove('surcharge-batches', action.id, '人工确认删除加收批次');
    if (action.kind === 'batch-stop') await resourceApi.changeStatus('finance-express-fee-batches', action.id, 'stopped', '人工确认停用加收批次');
    if (action.kind === 'surcharge-stop') await resourceApi.changeStatus('finance-express-surcharges', action.id, 'stopped', '人工确认停用加收规则');
    if (action.kind === 'surcharge-delete') await resourceApi.remove('finance-express-surcharges', action.id, '人工确认删除加收规则');
    setAction(null); refresh();
  }
  const surchargeColumns: Col<SurchargeRow>[] = [
    { key: 'name', head: '加收名称', cell: row => row.name, csv: row => row.name }, { key: 'type', head: '加收方式', cell: row => CHARGE[row.chargeType], csv: row => CHARGE[row.chargeType] },
    { key: 'province', head: '适用省份', cell: row => row.areaScope || '-', csv: row => row.areaScope }, { key: 'weight', head: '重量范围', cell: surchargeWeight, csv: surchargeWeight },
    { key: 'amount', head: '加收值', cell: row => row.chargeType === 'percent' ? `${row.percent ?? 0}%` : money(row.amount), csv: row => row.percent ?? row.amount },
    { key: 'start', head: '生效日期', cell: row => row.effectiveStart || '-', csv: row => row.effectiveStart }, { key: 'end', head: '失效日期', cell: row => row.effectiveEnd || '长期', csv: row => row.effectiveEnd },
    { key: 'file', head: '凭据', cell: row => row.fileName || '-', csv: row => row.fileName }, { key: 'status', head: '状态', cell: row => row.status === 'active' ? '启用' : '停用', csv: row => row.status },
    { key: 'note', head: '备注', cell: row => row.note || '-', csv: row => row.note }, { key: 'actions', head: '操作', action: true, cell: row => <div className="row-actions">{row.status === 'active' && can('disable') && <button type="button" className="link-button" onClick={() => setAction({ kind: 'surcharge-stop', id: row.id, name: row.name })}>停用</button>}{can('delete') && <button type="button" className="link-button danger" onClick={() => setAction({ kind: 'surcharge-delete', id: row.id, name: row.name })}>删除</button>}</div> },
  ];
  return <div className="express-version-content">
    <div className="express-version-summary"><div><strong>{carrier.name} / {branch.name} / {version.name}</strong><span><b>{COOP[version.cooperationStatus]}</b> · {version.effectiveStart || '未设生效日'} 至 {version.effectiveEnd || '长期'}</span></div><div className="row-actions">{onBack && <button type="button" className="secondary-button" onClick={onBack}>返回版本列表</button>}{can('edit') && <button type="button" className="primary-button" onClick={() => setEditing(true)}>编辑版本资料</button>}</div></div>
    {error && <div role="alert" className="notice error">{error}</div>}{notice && <div role="status" className="notice ok">{notice}</div>}
    {!detail ? !error && <p>读取中…</p> : <>
      <div className="express-version-layout"><QueryPanel title="基础价格规则"><QueryTable cols={ruleColumns} rows={rules} rowKey={row => row.id} empty="暂无基础价格规则" foot={false} caption="基础价格规则" controls={{ storageKey: `express-prices:${version.id}`, pageSize: 50, searchPlaceholder: '搜索省份、重量、版本' }} /></QueryPanel>
        <aside className="express-version-side"><QueryPanel title="配置选项"><div className="express-config-actions">{can('edit') && <><button type="button" className="primary-button" onClick={() => setRecognize('price')}>上传价格表识别</button><button type="button" className="secondary-button" onClick={() => setManual(true)}>手工维护价格</button></>}<button type="button" className="secondary-button" onClick={() => setInfo({ title: '原始价格表', content: <><p>{String(data.attachmentName || '暂未上传原始价格表')}</p><strong>{data.attachmentName ? '已保存原始价格表文件名' : '还没有原始价格表'}</strong><p>{String(data.attachmentName || '通过“上传价格表识别”确认导入后，会把本次上传文件记录为当前原始价格表。')}</p></> })}>查看原始价格表</button>{can('edit') && <><button type="button" className="secondary-button" onClick={() => setRecognize('surcharge')}>上传加收通知识别</button><button type="button" className="secondary-button" onClick={() => setSurcharge(true)}>新增临时加收</button></>}<button type="button" className="secondary-button" onClick={() => setInfo({ title: '快递价格历史记录', content: <QueryTable cols={recordsColumns} rows={detail.recognitions} rowKey={row => row.id} empty="还没有识别记录" foot={false} caption="快递价格历史记录" controls={{ storageKey: `express-recognition:${version.id}`, pageSize: 8, searchPlaceholder: '搜索上传文件、识别类型或模型' }} /> })}>查看识别记录</button></div><label className="express-price-source">最终价格依据<select aria-label="最终价格依据" disabled={!can('edit')} value={String(data.priceSource || detail.effectiveSource)} onChange={e => void run(() => resourceApi.update('finance-express-versions', version.id, { priceSource: e.target.value }))}><option value="ai">AI 识别价格表</option><option value="manual">手工创建价格表</option></select></label></QueryPanel>
          <QueryPanel title="版本信息"><dl><div><dt>合作状态</dt><dd>{COOP[version.cooperationStatus]}</dd></div><div><dt>生效日期</dt><dd>{version.effectiveStart || '-'}</dd></div><div><dt>失效日期</dt><dd>{version.effectiveEnd || '长期有效'}</dd></div><div><dt>可发货重量</dt><dd>{version.shippingWeightMin ?? 0}–{version.shippingWeightMax ?? '不限'}kg</dd></div><div><dt>原始价格表</dt><dd>{String(data.attachmentName || '未上传')}</dd></div></dl></QueryPanel>
          <QueryPanel title="当前口径"><dl><div><dt>版本命中</dt><dd>同一日期只能命中一个基础价格版本。</dd></div><div><dt>加收命中</dt><dd>同一日期可命中多条临时加收，并逐条累加。</dd></div><div><dt>AI识别</dt><dd>价格表和加收截图只做预填，人工确认后生效。</dd></div></dl></QueryPanel></aside>
      </div>
      <QueryPanel title="临时加收与上传记录"><div className="express-surcharge-section"><strong>加收通知批次</strong><p>每次上传识别或手工新增都是一个模块；整批可停用或删除，规则仍可单条处理。</p>{detail.batches.map(batch => {
        const rows = detail.surcharges.filter(row => row.batchId === batch.id), active = rows.filter(row => row.status === 'active');
        return <section key={batch.id} className="express-surcharge-batch"><header><div><strong>{batch.batchName}</strong><small>{batch.source === 'manual' ? '手工新增' : 'AI识别'}{batch.createdAtKey ? ` · ${when(batch.createdAtKey)}` : ''}{batch.fileName ? ` · ${batch.fileName}` : ''}</small></div><div className="row-actions"><span className="pill">{batch.status === 'active' ? '已生效' : '已停用'}</span><button type="button" className="secondary-button" onClick={() => void evidence(batch)}>查看凭据</button>{active.length > 0 && can('disable') && <button type="button" className="secondary-button" onClick={() => setAction({ kind: 'batch-stop', id: batch.id, name: batch.batchName })}>停用整批</button>}{can('delete') && <button type="button" className="secondary-button danger" onClick={() => setAction({ kind: 'batch-delete', id: batch.id, name: batch.batchName })}>删除整批</button>}</div></header><div className="express-surcharge-batch-meta"><span><b>规则总数</b>{rows.length} 条</span><span><b>有效规则</b>{active.length} 条</span><span><b>原始凭据</b>{batch.fileName || '-'}</span><span><b>模型/来源</b>{batch.modelName || (batch.source === 'manual' ? '人工录入' : '-')}</span></div>{batch.note && <p>{batch.note}</p>}<QueryTable cols={surchargeColumns} rows={rows} rowKey={row => row.id} empty="没有加收规则" caption="本批次加收规则" foot={false} controls={{ storageKey: `express-surcharge:${batch.id}`, pageSize: 8, searchPlaceholder: '搜索本批次加收名称、地区或金额' }} /></section>;
      })}{detail.surcharges.some(row => !row.batchId) && <QueryTable cols={surchargeColumns} rows={detail.surcharges.filter(row => !row.batchId)} rowKey={row => row.id} empty="没有历史散项" foot={false} caption="历史散项" controls={{ storageKey: `express-surcharge-legacy:${version.id}`, pageSize: 8 }} />}{!detail.batches.length && !detail.surcharges.length && <div className="empty-state"><strong>还没有临时加收</strong><p>上传加收通知识别或手工新增后，会按每次上传批次分模块显示。</p></div>}<details><summary>查看上传识别记录</summary><QueryTable cols={recordsColumns} rows={detail.recognitions} rowKey={row => row.id} empty="还没有识别记录" foot={false} controls={{ storageKey: `express-recognition-inline:${version.id}`, searchPlaceholder: '搜索上传文件或识别类型' }} /></details></div></QueryPanel>
      <QueryPanel title="合作备注"><label className="express-cooperation-note">快递合作具体内容、退改费、其他费用和特殊口径<textarea value={remark} disabled={!can('edit')} placeholder="例如：退改费规则、特殊区域费用、对账注意事项、快递合作联系人口径、赔付或拦截费用等。" onChange={e => { setRemark(e.target.value); remarkRef.current = e.target.value; dirtyRemarkRef.current = true; setRemarkDirty(true); }} onBlur={() => void saveRemark()} /></label><small>备注会保存到当前价格历史版本里，不影响其他版本。</small></QueryPanel>
    </>}
    {editing && <HierarchyForm carriers={[carrier]} state={{ kind: 'version', id: version.id, branchId: branch.id }} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
    {manual && detail && <ManualPriceDialog versionId={version.id} rules={detail.rules.filter(row => row.source === 'manual')} onClose={() => setManual(false)} onSaved={() => { setManual(false); refresh(); }} />}
    {recognize && <RecognizeDialog versionId={version.id} kind={recognize} onClose={() => setRecognize(null)} onDone={message => { setRecognize(null); setNotice(message); refresh(); }} />}
    {surcharge && <SurchargeDialog versionId={version.id} onClose={() => setSurcharge(false)} onSaved={() => { setSurcharge(false); refresh(); }} />}
    {rule && <PriceRuleDialog rule={rule} onClose={() => setRule(null)} onSaved={() => { setRule(null); refresh(); }} />}
    {action && <ReasonDialog requireReason={false} title={action.kind.endsWith('stop') ? '确认停用' : '确认删除'} hint={`${action.kind.endsWith('stop') ? '确定停用' : '确定删除'}“${action.name}”吗？${action.kind === 'batch-delete' ? '该批次下的规则也会一起删除。' : ''}`} confirmLabel={action.kind.endsWith('stop') ? '确认停用' : '确认删除'} danger onClose={() => setAction(null)} onConfirm={confirmAction} />}
    {info && <div className="modal-backdrop" role="presentation"><section className="modal card wide express-info-dialog" role="dialog" aria-modal="true" aria-label={info.title}><div className="modal-head"><h3>{info.title}</h3><button type="button" className="secondary-button" onClick={() => setInfo(null)}>关闭</button></div><div className="modal-body">{info.content}</div></section></div>}
  </div>;
}
