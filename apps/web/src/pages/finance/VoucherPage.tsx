import { useState } from 'react';
import { DOC_TYPE_MAP, type DocType } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { DocForm } from './DocForm';
import { DocumentsPage } from './DocumentsPage';

/** 制单中心：打开就是一张开单页（管家婆式），保存后清空接着开下一张；下面是这种单据最近开过的。 */
export function VoucherPage({ type }: { type: DocType }) {
  const { can } = useAuth();
  const def = DOC_TYPE_MAP.get(type)!;
  const [tick, setTick] = useState(0);
  return (
    <div>
      <div className="page-head between"><h1>{def.label}</h1></div>
      {can('finance.docs.create')
        ? <DocForm key={type} type={type} inline onSaved={() => setTick((t) => t + 1)} />
        : <div className="notice">你没有制单权限，只能查看下面的单据。</div>}
      <h2 className="section-title" style={{ marginTop: 24 }}>最近的{def.label}</h2>
      <DocumentsPage key={`${type}-${tick}`} scope={type} embedded />
    </div>
  );
}
