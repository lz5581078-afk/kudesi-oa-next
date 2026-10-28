import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { resourceApi } from './api';

interface Usage { templateKey: string; label: string; version: number; draft: boolean; stepName: string }

/**
 * 职责组详情顶部：所属部门、成员（名单）、职责明细条数、被哪些流程引用。
 * 旧系统列表和关键信息里有“成员 N 人 / 职责明细 N 条”，没有成员的组要一眼看出来；
 * 流程引用来自流程配置里“按职责组办理”的步骤（只有能看流程配置的人才看得到，看不到时这一行不显示）。
 */
export function DutyGroupSummary({ groupId, departmentLabel }: { groupId: number; departmentLabel?: string | null }) {
  const [n, setN] = useState<{ members: number; items: number; names: string[] } | null>(null);
  const [usage, setUsage] = useState<Usage[] | null>(null);
  useEffect(() => {
    const q = { pageSize: 1, fieldKey: 'groupId', fieldValue: groupId } as const;
    Promise.all([resourceApi.list('duty-group-members', { ...q, pageSize: 30 }), resourceApi.list('duty-group-items', q)])
      .then(([m, i]) => setN({ members: m.total, items: i.total, names: m.items.filter((x) => x.status === 'normal').map((x) => x.refLabels?.userId || x.title).filter(Boolean) }))
      .catch(() => setN(null));
    setUsage(null);
    api<Usage[]>(`/flow/duty-group-usage/${groupId}`).then(setUsage).catch(() => setUsage(null));
  }, [groupId]);
  if (!n) return null;
  return (
    <div className="dg-summary" aria-label="职责组概况">
      <p className="pill-row">
        <span>成员 {n.members} 人</span> · <span>职责明细 {n.items} 条</span>
        {n.members === 0 && <span className="pill warn"> 还没有成员，流程按此组派单会找不到人</span>}
      </p>
      {departmentLabel !== undefined && (
        <div className="dg-row"><small className="muted">所属部门</small>{departmentLabel ? <strong>{departmentLabel}</strong> : <span className="pill warn">未分类</span>}</div>
      )}
      {n.names.length > 0 && <div className="dg-row"><small className="muted">在组成员</small><span>{n.names.slice(0, 12).join('、')}{n.members > 12 ? ` 等 ${n.members} 人` : ''}</span></div>}
      {usage && (
        <div className="dg-row" aria-label="流程引用">
          <small className="muted">被流程引用</small>
          {usage.length === 0 ? <span className="muted">暂时没有流程把它设为办理人</span> : <span>{usage.map((u) => `${u.label}「${u.stepName}」${u.draft ? '（草稿）' : ''}`).join('、')}</span>}
        </div>
      )}
    </div>
  );
}
