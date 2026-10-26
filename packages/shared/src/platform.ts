/** 平台后台（管理所有公司）用到的类型与校验。 */

export type CompanyApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface CompanyApplicationDto {
  id: number;
  companyName: string;
  contactName: string;
  contactPhone: string;
  contactTitle: string | null;
  remark: string | null;
  status: CompanyApplicationStatus;
  rejectReason: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  approvedCompanyId: number | null;
  approvedCompanyName: string | null;
  createdAt: string;
}

export interface PlatformCompanyDto {
  id: number;
  code: string;
  name: string;
  status: 'active' | 'suspended';
  userCount: number;
  adminAccounts: string[];
  createdAt: string;
}

/** 管理员账号 = 联系人手机号。 */
export const PHONE_PATTERN = /^1[3-9]\d{9}$/;
export const APPLY_PASSWORD_MIN = 10;
