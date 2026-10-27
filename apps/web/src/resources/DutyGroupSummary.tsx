import { useEffect, useState } from 'react';
import { resourceApi } from './api';

/** 职责组详情顶部的人数/条数：旧系统列表和关键信息里有“成员 N 人 / 职责明细 N 条”，没有成员的组要一眼看出来。 */
export function DutyGroupSummary({ groupId }: { groupId: number }) {
  const [n, setN] = useState<{ members: number; items: number } | null>(null);
  useEffect(() => {
    const q = { pageSize: 1, fieldKey: 'groupId', fieldValue: groupId } as const;
    Promise.all([resourceApi.list('duty-group-members', q), resourceApi.list('duty-group-items', q)])
      .then(([m, i]) => setN({ members: m.total, items: i.total }))
      .catch(() => setN(null));
  }, [groupId]);
  if (!n) return null;
  return (
    <p className="pill-row" aria-label="职责组概况">
      <span>成员 {n.members} 人</span> · <span>职责明细 {n.items} 条</span>
      {n.members === 0 && <span className="pill warn"> 还没有成员，流程按此组派单会找不到人</span>}
    </p>
  );
}
