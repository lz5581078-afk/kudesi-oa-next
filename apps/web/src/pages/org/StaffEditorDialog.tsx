import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createChecker } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { StaffDialog } from './StaffDialog';
import { orgApi, type DepartmentNode, type PositionDto, type StaffDetail, type StaffDto } from './orgApi';
import { resourceApi, type ResourceDto } from '../../resources/api';
import { errText } from './OrgDialogs';

/** 部门和岗位只持有成员摘要，编辑前读取完整员工资料，避免覆盖主岗、兼任、上级和薪资。 */
export function StaffEditorDialog({ id, workforce = false, onClose, onSaved }: { id: number | null; workforce?: boolean; onClose: () => void; onSaved: (created?: { account: string; password: string }) => void }) {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  const allowed = can('org.staff.view') && (id === null ? can('org.staff.create') && can('resource.workforce.create') : can('org.staff.edit'));
  const [data, setData] = useState<{
    staff: StaffDetail | null;
    record: ResourceDto | null;
    all: StaffDto[];
    tree: DepartmentNode[];
    positions: PositionDto[];
  } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!allowed) return;
    let current = true;
    setData(null);
    setError('');
    Promise.all([id === null ? Promise.resolve(null) : orgApi.staffOne(id), orgApi.staff(), orgApi.departments(), orgApi.positions()])
      .then(async ([staff, all, tree, positions]) => {
        const record = workforce && staff?.workforceId ? await resourceApi.get('workforce', staff.workforceId) : null;
        if (current) setData({ staff, record, all, tree, positions });
      })
      .catch((e) => {
        if (current) setError(errText(e, '员工资料加载失败'));
      });
    return () => {
      current = false;
    };
  }, [id, workforce, allowed, retry]);
  if (allowed && data)
    return (
      <StaffDialog
        key={id ?? 'new'}
        staff={data.staff}
        all={data.all}
        departments={data.tree}
        positions={data.positions}
        canSalary={can('org.staff.salary')}
        workforce={workforce ? {
          record: data.record,
          canAccount: id === null || can('resource.workforce.edit'),
          canPassword: can('org.staff.reset') && (id === null || can('resource.workforce.edit')),
        } : undefined}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  return createPortal(
    <div className="modal-backdrop org-staff-backdrop">
      <section className="modal card small org-staff-dialog" role="dialog" aria-modal="true" aria-label="编辑员工">
        <div className="modal-head">
          <strong>编辑员工</strong>
        </div>
        <div className="modal-body">
          {!allowed ? (
            <p role="alert" className="notice error">
              需要员工查看和编辑权限才能修改员工资料。
            </p>
          ) : error ? (
            <p role="alert" className="notice error">
              {error}
            </p>
          ) : (
            <p role="status">正在读取员工资料…</p>
          )}
        </div>
        <div className="modal-foot">
          <button className="secondary-button" onClick={onClose}>
            关闭
          </button>
          {allowed && error && (
            <button className="primary-button" onClick={() => setRetry((n) => n + 1)}>
              重试
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
