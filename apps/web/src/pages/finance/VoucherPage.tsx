import { useRef, useState } from 'react';
import { DOC_TYPE_MAP, type DocType } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DocForm } from './DocForm';
import { DocumentsPage } from './DocumentsPage';
import { financeApi, type DocDetailDto } from './financeApi';

/**
 * 制单中心：每种单据一个入口，打开就是一张开单页（管家婆式：工具条 + 单据头 + 明细网格 + 收付款），
 * 保存后清空接着开下一张；可以“调入草稿”接着改；下面是这种单据最近开过的（单据调阅）。
 * 所有单据页共用同一个 DocForm，差别全部来自 packages/shared 的单据配置。
 */
export function VoucherPage({ type }: { type: DocType }) {
  const { can } = useAuth();
  const def = DOC_TYPE_MAP.get(type)!;
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<DocDetailDto | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loadError, setLoadError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const pick = async (id: number) => {
    setLoadError('');
    try { setEditing(await financeApi.doc(id)); setNonce((n) => n + 1); document.querySelector('.vc-slip')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }
    catch (e) { setLoadError(e instanceof ApiError ? e.message : '草稿调入失败'); }
  };
  return (
    <div className="vc-page">
      <div className="page-head between"><h1>{def.label}</h1></div>
      {loadError && <div role="alert" className="notice error">{loadError}</div>}
      {can('finance.docs.create')
        ? <DocForm key={`${type}-${editing?.id ?? 'new'}-${nonce}`} type={type} doc={editing ?? undefined} inline
            onSaved={() => { setEditing(null); setTick((t) => t + 1); }}
            onClose={() => { setEditing(null); setNonce((n) => n + 1); }}
            onPickDraft={(id) => void pick(id)}
            onShowList={() => listRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })} />
        : <div className="notice">你没有制单权限，只能查看下面的单据。</div>}
      <div ref={listRef} className="vc-recent">
        <h2 className="section-title">最近的{def.label}（单据调阅）</h2>
        <DocumentsPage key={`${type}-${tick}`} scope={type} embedded />
      </div>
    </div>
  );
}
