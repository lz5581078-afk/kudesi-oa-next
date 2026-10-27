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

/** 平台级接口应用：整个平台共用一套应用密钥（旧系统 integration_app_configs），各公司再各自授权。 */
export const PLATFORM_INTEGRATIONS = [
  { key: 'jushuitan', label: '聚水潭' },
  { key: 'feishu', label: '飞书' },
  { key: 'hikvision', label: '海康威视' },
] as const;
export const PLATFORM_INTEGRATION_ENVIRONMENTS = [
  { key: 'production', label: '正式环境' },
  { key: 'sandbox', label: '沙箱/测试环境' },
] as const;

export interface PlatformIntegrationAppDto {
  id: number;
  integrationKey: string;
  environment: string;
  /** 只给脱敏后的样子（前 3 后 4），不给明文 */
  appKeyMasked: string;
  secretConfigured: boolean;
  baseUrl: string | null;
  status: 'active' | 'disabled';
  remark: string | null;
  updatedAt: string;
}
