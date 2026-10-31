import { useEffect, useRef, type ReactNode } from 'react';
import { Database, FolderTree, ImagePlus, X } from 'lucide-react';
import type { ResourceDef } from '@kudesi/shared';
import type { ResourceDto } from './api';
import { CopyButton } from './CopyValue';
import { displayValue, statusOf } from './format';
import { FinanceFields, FinanceSection } from './FinanceDetailFields';
import { FinanceProductDetail } from './FinanceProductDetail';
import { FinanceBaseCodeDetail, FinanceBundleDetail } from './FinanceCodeDetail';
import { ReferenceRecordHistory } from './ReferenceRecordHistory';
import { referencePartyGroups, referenceRecordLabel } from './referenceFormLayout';
import { FileList } from './FilesField';
import type { DetailNav } from './DetailHead';
import './financeRecordDetail.css';

export function FinanceDetailBackdrop({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>('[aria-label="关闭详情"]')?.focus();
    return () => { previous?.focus(); };
  }, []);
  return <div className="finance-detail-backdrop" ref={root} onKeyDown={e => {
    if (e.key !== 'Tab' || root.current?.querySelectorAll('[role="dialog"]').length !== 1) return;
    const focusable = [...root.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(el => !el.closest('[hidden]'));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }}>{children}</div>;
}

export function FinanceDetailHead({ def, record, nav, onClose }: { def: ResourceDef; record: ResourceDto; nav?: DetailNav; onClose: () => void }) {
  const supplier = def.key === 'finance-suppliers', product = def.key === 'finance-products', code = ['finance-base-codes', 'finance-bundles'].includes(def.key);
  const label = referenceRecordLabel(def.key, record.data), status = statusOf(def, record.status);
  const title = supplier ? '查看供应商' : code ? `${label}详情` : String(record.data.name || record.title || `${label}详情`);
  return <header className="finance-detail-head"><div>{supplier && <small className="finance-detail-kicker"><FolderTree size={20} />财务基础资料</small>}<div className="finance-detail-title"><h2 className="rd-title">{title}</h2>{product && !['raw', 'shipping_material'].includes(String(record.data.archiveType)) && <span className={`pill ${status.tone}`}>{status.label}</span>}</div><p>{supplier ? '查看供应商资料，银行信息可整组或逐项复制。' : code ? String(record.data.code || record.title) : product ? `查看${label}的基础资料和系统编号。` : `${def.label}详情、分类归属和操作记录。`}</p></div><div className="finance-detail-head-actions">{nav && <div className="finance-detail-nav"><button type="button" aria-label="上一条" disabled={!nav.onPrev} onClick={nav.onPrev}>↑</button><small aria-label={`第 ${nav.index} 条，共 ${nav.total} 条`}>{nav.index}/{nav.total}</small><button type="button" aria-label="下一条" disabled={!nav.onNext} onClick={nav.onNext}>↓</button></div>}<button type="button" className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={22} /></button></div></header>;
}

function SupplierDetail({ def, record }: { def: ResourceDef; record: ResourceDto }) {
  const groups = referencePartyGroups(def.key, def.fields.filter(f => !f.listOnly));
  const bank = [['供应商名称', record.data.name || record.title], ['账户名称', record.data.bankAccountName], ['开户行', record.data.bank], ['银行账号', record.data.bankAccountNo]].filter(([, value]) => String(value ?? '').trim()).map(([label, value]) => `${label}：${String(value).trim()}`).join('\n');
  return <>{groups.filter(([title]) => title !== '补充资料').map(([title, fields]) => title === '归入分类'
    ? <section className="finance-supplier-category" key={title}><div><FolderTree size={20} /><span>归入分类</span></div><strong>{record.refLabels.categoryIds || '未选择分类'}</strong><small>{record.refLabels.categoryIds?.includes('种子') ? '种子供应商可关联多个供应产品分类' : '供应商显示在该目录的直属列表中'}</small></section>
    : <FinanceSection key={title} title={title} step={['基础资料', '联系资料', '收款与银行资料'].indexOf(title) + 1 || undefined} hint={title === '基础资料' ? '与新增供应商的字段排列一致' : title === '联系资料' ? '用于业务联系和后续单据引用' : title === '收款与银行资料' ? <CopyButton value={bank} label="全部银行信息" /> : '编码按分类和名称生成'} className={title === '系统自动编号' ? 'finance-supplier-code' : 'finance-supplier-section'}><div className="finance-supplier-fields">{fields.map(field => {
      const bankField = ['bankAccountName', 'bank', 'bankAccountNo'].includes(field.key);
      return field.type === 'files' ? <div key={field.key} className="wide"><span>{field.label}</span><small>支持微信、支付宝或银行收款码图片</small>{Array.isArray(record.data[field.key]) && (record.data[field.key] as number[]).length ? <FileList ids={record.data[field.key] as number[]} files={record.files} /> : <div className="finance-payment-empty"><ImagePlus size={22} /><span>尚未上传</span></div>}</div> : <label key={field.key} className={['note', 'bankAccountNo'].includes(field.key) || title === '系统自动编号' ? 'wide' : undefined}><span>{field.label}</span><div className={bankField ? 'finance-supplier-copy' : undefined}>{field.type === 'textarea' ? <textarea value={displayValue(field, record)} disabled /> : <input value={displayValue(field, record)} disabled />}{(bankField || field.key === 'code') && <CopyButton value={displayValue(field, record)} label={def.fields.find(f => f.key === field.key)?.label ?? field.label} />}</div></label>;
    })}</div></FinanceSection>)}{groups.some(([title, fields]) => title === '补充资料' && fields.some(f => record.data[f.key] != null && record.data[f.key] !== '')) && <details className="finance-detail-extra"><summary>补充资料</summary><FinanceFields def={def} record={record} keys={groups.find(([title]) => title === '补充资料')![1].map(f => f.key)} /></details>}</>;
}

export function FinanceDetailBody({ def, record }: { def: ResourceDef; record: ResourceDto }) {
  if (def.key === 'finance-products') return <FinanceProductDetail record={record} />;
  if (def.key === 'finance-base-codes') return <FinanceBaseCodeDetail record={record} />;
  if (def.key === 'finance-bundles') return <FinanceBundleDetail record={record} />;
  if (def.key === 'finance-suppliers') return <SupplierDetail def={def} record={record} />;
  const groups = referencePartyGroups(def.key, [...def.fields]);
  const group = groups.find(([title]) => title === '基础信息')!;
  const extra = groups.find(([title]) => title === '补充资料')?.[1].filter(f => record.data[f.key] != null && record.data[f.key] !== '') ?? [];
  return <><FinanceSection title="基础信息" hint={<Database size={18} />}><dl className="finance-view-fields"><div><dt>{def.key === 'finance-customers' ? '客户分类' : '费用分类'}</dt><dd>{record.refLabels[def.key === 'finance-customers' ? 'categoryIds' : 'categoryId'] || '未分类'}</dd></div><div><dt>状态</dt><dd><span className={`pill ${statusOf(def, record.status).tone}`}>{statusOf(def, record.status).label}</span></dd></div></dl><FinanceFields def={def} record={record} keys={group[1].filter(f => !['categoryIds', 'categoryId'].includes(f.key)).map(f => [f.key, f.label])} /></FinanceSection><ReferenceRecordHistory key={record.updatedAt} type={def.key} id={record.id} label={def.key === 'finance-customers' ? '客户' : '费用'} />{extra.length > 0 && <details className="finance-detail-extra"><summary>补充资料</summary><FinanceFields def={def} record={record} keys={extra.map(f => f.key)} /></details>}</>;
}
