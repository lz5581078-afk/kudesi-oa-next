/**
 * 软归档：旧系统里这些资料不物理删除，而是“归档”（必须填原因，可恢复，关联和业务历史原样保留）。
 * archivedStatus = 归档后显示的状态（各资料原有的“停用/注销”值）；defaultStatus = 恢复时没有原状态可用的兜底。
 */
export interface ArchivePolicy {
  archivedStatus: string;
  defaultStatus: string;
}

export const ARCHIVE_POLICY: Readonly<Record<string, ArchivePolicy>> = {
  licenses: { archivedStatus: 'inactive', defaultStatus: 'normal' },
  stores: { archivedStatus: 'inactive', defaultStatus: 'normal' },
  'tax-profiles': { archivedStatus: 'inactive', defaultStatus: 'normal' },
  partners: { archivedStatus: 'terminated', defaultStatus: 'active' },
  phones: { archivedStatus: 'inactive', defaultStatus: 'normal' },
  broadband: { archivedStatus: 'cancelled', defaultStatus: 'normal' },
  'bank-accounts': { archivedStatus: 'inactive', defaultStatus: 'normal' },
  qualifications: { archivedStatus: 'inactive', defaultStatus: 'normal' },
  trademarks: { archivedStatus: 'inactive', defaultStatus: 'applying' },
  'self-media': { archivedStatus: 'inactive', defaultStatus: 'normal' },
  wechat: { archivedStatus: 'inactive', defaultStatus: 'normal' },
  memos: { archivedStatus: 'inactive', defaultStatus: 'normal' },
  software: { archivedStatus: 'inactive', defaultStatus: 'normal' },
  'fixed-assets': { archivedStatus: 'retired', defaultStatus: 'idle' },
  archives: { archivedStatus: 'archived', defaultStatus: 'stored' },
  'u-shields': { archivedStatus: 'inactive', defaultStatus: 'normal' },
};

export const archivePolicyOf = (key: string): ArchivePolicy | undefined => ARCHIVE_POLICY[key];
