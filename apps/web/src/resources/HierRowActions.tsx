import { useState } from 'react';
import { archivePolicyOf, COPY_OMIT_FIELDS, type ResourceDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { ReasonDialog, clearRefCache } from './RecordForm';

/** 复制新增：按这条的内容带一份新的，编号、图片、敏感字段不带过去（和详情页“复制新建”一致） */
export function copyValuesOf(def: ResourceDef, data: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.readonly || f.type === 'files' || f.type === 'secret' || f.type === 'sensitive' || f.key === 'code' || f.key === def.uniqueField || def.copyOmit?.includes(f.key) || (def.key === 'finance-products' && COPY_OMIT_FIELDS.includes(f.key))) continue;
    const v = data[f.key];
    if (v !== undefined && v !== null && v !== '') values[f.key] = v;
  }
  return values;
}

/**
 * 分级布局列表每行末尾的操作：查看、编辑、复制新增、（商品）成本明细、停用/启用、删除（旧版财务档案同款）。
 * 停用和删除都要写原因；点按钮不会打开详情。
 */
export function HierRowActions({ def, row, can, onOpen, onEdit, onCopy, onCost, onDone }: {
  def: ResourceDef;
  row: ResourceDto;
  can: (a: 'create' | 'edit' | 'disable' | 'delete') => boolean;
  onOpen: (id: number) => void;
  onEdit: (row: ResourceDto) => void;
  onCopy: (values: Record<string, unknown>) => void;
  /** 商品档案的“成本明细”：打开详情的成本明细页签 */
  onCost?: (id: number) => void;
  onDone: (message?: string) => void;
}) {
  const [asking, setAsking] = useState<'off' | 'on' | 'del' | null>(null);
  const [error, setError] = useState('');
  const off = def.statuses.find((s) => s.value === 'inactive') ?? def.statuses.find((s) => s.hidden && s.value !== 'deleted');
  const on = def.statuses.find((s) => s.value === def.defaultStatus);
  const stopped = Boolean(off && row.status === off.value);
  const archivable = Boolean(archivePolicyOf(def.key));
  const live = !row.archived;
  const act = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); setError(''); fn(); };
  return (
    <span className="row-acts hier-acts" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="row-act" aria-label={`查看：${row.title}`} onClick={act(() => onOpen(row.id))}>查看</button>
      {live && can('edit') && <button type="button" className="row-act" aria-label={`编辑：${row.title}`} onClick={act(() => onEdit(row))}>编辑</button>}
      {live && can('create') && <button type="button" className="row-act" aria-label={`复制新增：${row.title}`} title="按这条的内容新增一条，编号、图片不带过去" onClick={act(() => onCopy({ ...copyValuesOf(def, row.data), ...(def.key === 'finance-products' ? { __copyOf: row.id } : {}) }))}>复制新增</button>}
      {onCost && <button type="button" className="row-act" aria-label={`成本明细：${row.title}`} onClick={act(() => onCost(row.id))}>成本明细</button>}
      {live && can('disable') && off && on && (
        <button type="button" className="row-act" aria-label={`${stopped ? '启用' : '停用'}：${row.title}`} onClick={act(() => setAsking(stopped ? 'on' : 'off'))}>{stopped ? '启用' : '停用'}</button>
      )}
      {live && can('delete') && <button type="button" className="row-act danger" aria-label={`${archivable ? '归档' : '删除'}：${row.title}`} onClick={act(() => setAsking('del'))}>{archivable ? '归档' : '删除'}</button>}
      {error && <small role="alert" className="row-act-err">{error}</small>}
      {asking && asking !== 'del' && off && on && (
        <ReasonDialog
          title={`${asking === 'off' ? '停用' : '启用'}：${row.title}`}
          hint={asking === 'off' ? `停用后默认不再显示，原因会写入${def.label}的操作记录。` : '启用后恢复为正常状态，重新出现在默认列表里。'}
          confirmLabel={asking === 'off' ? '确认停用' : '确认启用'}
          suggestions={asking === 'off' ? ['不再使用', '重复录入', '信息有误'] : ['恢复使用', '误停用']}
          danger={asking === 'off'}
          onClose={() => setAsking(null)}
          onConfirm={async (reason) => {
            try {
              await resourceApi.changeStatus(def.key, row.id, asking === 'off' ? off.value : on.value, reason);
              clearRefCache(def.key);
              setAsking(null);
              onDone(`「${row.title}」已${asking === 'off' ? '停用' : '启用'}`);
            } catch (e) { setError(e instanceof ApiError ? e.message : '操作失败'); setAsking(null); }
          }}
        />
      )}
      {asking === 'del' && (
        <ReasonDialog
          title={`${archivable ? '归档' : '删除'}：${row.title}`}
          hint={archivable ? '归档后不再出现在日常列表，关联和历史记录保留，可在“已归档”里恢复。' : '删除后无法恢复。还被其他资料引用时不能删除，请先解除引用，或改为停用。'}
          confirmLabel={archivable ? '确认归档' : '确认删除'}
          danger
          onClose={() => setAsking(null)}
          onConfirm={async (reason) => {
            await resourceApi.remove(def.key, row.id, reason);
            clearRefCache(def.key);
            setAsking(null);
            onDone(`「${row.title}」已${archivable ? '归档' : '删除'}`);
          }}
        />
      )}
    </span>
  );
}
