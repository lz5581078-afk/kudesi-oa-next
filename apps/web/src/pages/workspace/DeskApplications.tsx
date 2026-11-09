import { useEffect, useState } from 'react';
import { ArrowUpRight, ClipboardPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ApplyPage } from '../flow/ApplyPage';
import { flowApi, type TemplateInfo } from '../flow/flowApi';
import { SkuApplicationCenter } from '../flow/SkuApplicationCenter';

export function DeskApplications({ sku, purchase, exclusive, refreshKey, onSubmitted, operations = false }: {
  operations?: boolean;
  sku: boolean;
  purchase: boolean;
  exclusive: boolean;
  refreshKey: number;
  onSubmitted: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<TemplateInfo | null>(null);
  const [skuOpen, setSkuOpen] = useState(false);

  useEffect(() => {
    if (operations) { setTemplates([]); setError(false); return; }
    let active = true;
    flowApi.templates().then(rows => {
      if (!active) return;
      setTemplates(rows.filter(t => t.active && t.startable && !['sku-batch-apply', 'purchase-request', 'product-exclusive'].includes(t.key)));
      setError(false);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [refreshKey, operations]);

  return <section className="card ws-section" aria-label="发起申请">
    <div className="ws-head"><h2><ClipboardPlus size={17} /> 发起申请</h2></div>
    <div className="desk-action-list">
      {sku && <button type="button" onClick={() => setSkuOpen(true)}>SKU 批量申请 <ArrowUpRight size={15} /></button>}
      {!operations && purchase && <Link to="/flow/purchase">采购申请中心 <ArrowUpRight size={15} /></Link>}
      {exclusive && <Link to="/flow/exclusive">专属品领取 <ArrowUpRight size={15} /></Link>}
      {!operations && templates?.map(template => <button key={template.key} type="button" onClick={() => setSelected(template)}>{template.label}<ArrowUpRight size={15} /></button>)}
    </div>
    {error ? <p role="alert" className="muted ws-pad">申请入口读取失败，请刷新工作台。</p>
      : !templates ? <p role="status" className="muted ws-pad">正在读取申请入口…</p>
      : !sku && (operations || !purchase) && !exclusive && !templates.length ? <p className="muted ws-pad">暂无可发起的流程。</p> : null}
    {selected && <ApplyPage key={selected.key} initialTemplate={selected} onClose={() => setSelected(null)} onSubmitted={() => { setSelected(null); onSubmitted(); }} />}
    {skuOpen && <SkuApplicationCenter onClose={() => { setSkuOpen(false); onSubmitted(); }} />}
  </section>;
}
