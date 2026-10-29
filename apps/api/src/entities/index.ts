import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * 实体与迁移 0001 必须一致；表结构只通过迁移改，不用 synchronize。
 * 所有业务表都带 company_id，查询必须带公司条件（见 TenantScope 约定）。
 */

@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  /** 登录时填写的公司代码，全局唯一 */
  @Index('uq_companies_code', { unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'suspended';

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

@Entity('platform_admins')
export class PlatformAdmin {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Index('uq_platform_admin_account', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  account!: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 100 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 50 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'disabled';

  @Column({ name: 'last_login_at', type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

@Entity('company_applications')
export class CompanyApplication {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'company_name', type: 'varchar', length: 100 })
  companyName!: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 50 })
  contactName!: string;

  @Column({ name: 'contact_phone', type: 'varchar', length: 20 })
  contactPhone!: string;

  @Column({ name: 'admin_account', type: 'varchar', length: 64 })
  adminAccount!: string;

  @Column({ name: 'admin_password_hash', type: 'varchar', length: 100 })
  adminPasswordHash!: string;

  @Column({ name: 'contact_title', type: 'varchar', length: 50, nullable: true })
  contactTitle!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  remark!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: 'pending' | 'approved' | 'rejected';

  @Column({ name: 'reject_reason', type: 'varchar', length: 300, nullable: true })
  rejectReason!: string | null;

  @Column({ name: 'reviewed_by', type: 'int', unsigned: true, nullable: true })
  reviewedBy!: number | null;

  @Column({ name: 'reviewed_at', type: 'datetime', nullable: true })
  reviewedAt!: Date | null;

  @Column({ name: 'approved_company_id', type: 'int', unsigned: true, nullable: true })
  approvedCompanyId!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

@Entity('departments')
@Index('idx_departments_company_parent', ['companyId', 'parentId'])
export class Department {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  @Column({ name: 'parent_id', type: 'int', unsigned: true, nullable: true })
  parentId!: number | null;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder!: number;

  @Column({ type: 'varchar', length: 12, default: 'active' })
  status!: 'active' | 'inactive';

  /** 部门主管（显式字段；不再像旧系统那样按层级或名称猜） */
  @Column({ name: 'manager_id', type: 'int', unsigned: true, nullable: true })
  managerId!: number | null;

  /** 系统归档部门（如“离职员工”）：不出现在组织架构和部门选择里，不能编辑、删除 */
  @Column({ name: 'is_system', type: 'tinyint', width: 1, default: 0, transformer: boolTransformer() })
  isSystem!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

/**
 * 岗位。workspace_type 是显式字段，用来决定默认工作台和成本可见性等，
 * 不再像旧系统那样用名称正则猜“是不是运营/财务/仓库”。
 */
export type WorkspaceType =
  | 'boss'
  | 'general'
  | 'operations'
  | 'finance'
  | 'cashier'
  | 'warehouse'
  | 'purchasing'
  | 'support'
  | 'live_anchor'
  | 'live_control'
  | 'blank';

@Entity('positions')
@Index('uq_positions_company_name', ['companyId', 'name'], { unique: true })
export class Position {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  @Column({ name: 'department_id', type: 'int', unsigned: true, nullable: true })
  departmentId!: number | null;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'workspace_type', type: 'varchar', length: 32, default: 'blank' })
  workspaceType!: WorkspaceType;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder!: number;

  /** 岗位层级：老板 / 主管 / 员工 */
  @Column({ type: 'varchar', length: 12, default: 'staff' })
  level!: 'boss' | 'manager' | 'staff';

  @Column({ name: 'supervisor_position_id', type: 'int', unsigned: true, nullable: true })
  supervisorPositionId!: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 12, default: 'active' })
  status!: 'active' | 'inactive';

  /** 岗位编码，同一部门内唯一（可空） */
  @Column({ name: 'position_key', type: 'varchar', length: 64, nullable: true })
  positionKey!: string | null;
}

/** 岗位档案条目：岗位职责 / 入职培训 / 绩效考核 / 监督规则 / 流程节点说明，同一张表按分类区分。 */
@Entity('position_duties')
@Index('idx_position_duties', ['companyId', 'positionId'])
export class PositionDuty {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  @Column({ name: 'position_id', type: 'int', unsigned: true })
  positionId!: number;

  @Column({ type: 'varchar', length: 20 })
  category!: string;

  @Column({ type: 'varchar', length: 150 })
  title!: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  frequency!: string | null;

  @Column({ name: 'related_module', type: 'varchar', length: 60, nullable: true })
  relatedModule!: string | null;

  @Column({ name: 'completion_standard', type: 'varchar', length: 1000, nullable: true })
  completionStandard!: string | null;

  @Column({ name: 'is_key', type: 'tinyint', width: 1, default: 0, transformer: boolTransformer() })
  isKey!: boolean;

  @Column({ type: 'varchar', length: 12, default: 'active' })
  status!: 'active' | 'inactive';

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

@Entity('position_permissions')
@Index('uq_position_permission', ['positionId', 'permission'], { unique: true })
export class PositionPermission {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'position_id', type: 'int', unsigned: true })
  positionId!: number;

  @Column({ type: 'varchar', length: 100 })
  permission!: string;
}

@Entity('users')
@Index('uq_users_company_account', ['companyId', 'account'], { unique: true })
export class User {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  /** 登录账号全系统唯一；历史无账号人员用 NULL，不能登录。 */
  @Column({ type: 'varchar', length: 64, nullable: true })
  account!: string | null;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 50 })
  name!: string;

  @Column({ name: 'department_id', type: 'int', unsigned: true, nullable: true })
  departmentId!: number | null;

  @Column({ name: 'position_id', type: 'int', unsigned: true, nullable: true })
  positionId!: number | null;

  @ManyToOne(() => Position, { nullable: true })
  @JoinColumn({ name: 'position_id' })
  position?: Position | null;

  /** 兼任岗位（不含主岗位）；权限取主岗位和兼任岗位的并集 */
  @Column({ name: 'extra_position_ids', type: 'json', nullable: true })
  extraPositionIds!: number[] | null;

  @Column({ name: 'is_company_admin', type: 'tinyint', width: 1, default: 0, transformer: boolTransformer() })
  isCompanyAdmin!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'disabled';

  @Column({ name: 'must_change_password', type: 'tinyint', width: 1, default: 1, transformer: boolTransformer() })
  mustChangePassword!: boolean;

  /** 直属上级 */
  @Column({ name: 'manager_id', type: 'int', unsigned: true, nullable: true })
  managerId!: number | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  title!: string | null;

  /** 底薪，分；要 org.staff.salary 权限才能看、改 */
  @Column({ name: 'base_salary', type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  baseSalary!: number | null;

  /** 计薪方式：月薪（用底薪）/ 时薪（用 hourly_rate） */
  @Column({ name: 'pay_type', type: 'varchar', length: 12, default: 'monthly' })
  payType!: 'monthly' | 'hourly';

  /** 时薪，分/小时；要 org.staff.salary 权限才能看、改 */
  @Column({ name: 'hourly_rate', type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  hourlyRate!: number | null;

  /** 用工类型：正式 / 兼职 / 临时工 */
  @Column({ name: 'employment_type', type: 'varchar', length: 16, default: 'regular' })
  employmentType!: 'regular' | 'part_time' | 'temp';

  @Column({ name: 'last_login_at', type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

/** 员工薪酬记录：薪资变更（改月薪/时薪/计薪方式时自动写）、工资发放、奖励、处罚。金额为分。 */
@Entity('employee_compensation_records')
@Index('idx_comp_user_type', ['companyId', 'userId', 'recordType', 'createdAt'])
export class EmployeeCompensationRecord {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  @Column({ name: 'user_id', type: 'int', unsigned: true })
  userId!: number;

  /** salary_change / payroll / reward / penalty */
  @Column({ name: 'record_type', type: 'varchar', length: 40 })
  recordType!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'bigint', default: 0, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  amount!: number;

  @Column({ name: 'effective_date', type: 'date', nullable: true })
  effectiveDate!: string | null;

  @Column({ name: 'pay_period', type: 'varchar', length: 40, nullable: true })
  payPeriod!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;

  @Column({ name: 'source_type', type: 'varchar', length: 80, nullable: true })
  sourceType!: string | null;

  @Column({ name: 'source_id', type: 'bigint', unsigned: true, nullable: true })
  sourceId!: string | null;

  @Column({ name: 'actor_id', type: 'int', unsigned: true, nullable: true })
  actorId!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

@Entity('user_permission_overrides')
@Index('uq_user_permission_override', ['userId', 'permission'], { unique: true })
export class UserPermissionOverride {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'user_id', type: 'int', unsigned: true })
  userId!: number;

  @Column({ type: 'varchar', length: 100 })
  permission!: string;

  @Column({ type: 'varchar', length: 8 })
  effect!: 'allow' | 'deny';
}

@Entity('audit_logs')
@Index('idx_audit_company_time', ['companyId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  /** 操作人只取自登录令牌，从不取请求体 */
  @Column({ name: 'actor_id', type: 'int', unsigned: true, nullable: true })
  actorId!: number | null;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ name: 'resource_type', type: 'varchar', length: 64 })
  resourceType!: string;

  @Column({ name: 'resource_id', type: 'varchar', length: 64, nullable: true })
  resourceId!: string | null;

  @Column({ type: 'json', nullable: true })
  detail!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

function boolTransformer() {
  return {
    to: (value: boolean) => (value ? 1 : 0),
    from: (value: number | boolean) => value === 1 || value === true,
  };
}

/** 通用资料记录：字段定义见 packages/shared/src/resources.ts，字段值在 data(JSON)。 */
@Entity('resource_records')
@Index('uq_resource_unique', ['companyId', 'type', 'uniqueKey'], { unique: true })
export class ResourceRecord {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  @Column({ type: 'varchar', length: 32 })
  type!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ name: 'unique_key', type: 'varchar', length: 200, nullable: true })
  uniqueKey!: string | null;

  @Column({ type: 'varchar', length: 24 })
  status!: string;

  @Column({ name: 'status_reason', type: 'varchar', length: 500, nullable: true })
  statusReason!: string | null;

  @Column({ name: 'search_text', type: 'varchar', length: 1500, default: '' })
  searchText!: string;

  @Column({ type: 'json' })
  data!: Record<string, unknown>;

  /** 加密后的敏感字段：{ 字段key: 密文 }，整体序列化为 JSON 文本 */
  @Column({ type: 'text', nullable: true })
  secrets!: string | null;

  @Column({ name: 'created_by', type: 'int', unsigned: true, nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', unsigned: true, nullable: true })
  updatedBy!: number | null;

  /** 软归档（见 shared/archive-policy.ts）：归档后不出现在默认列表，可恢复 */
  @Column({ name: 'archived_at', type: 'datetime', nullable: true })
  archivedAt!: Date | null;

  @Column({ name: 'archived_by', type: 'int', unsigned: true, nullable: true })
  archivedBy!: number | null;

  @Column({ name: 'archive_reason', type: 'varchar', length: 500, nullable: true })
  archiveReason!: string | null;

  @Column({ name: 'archived_from_status', type: 'varchar', length: 24, nullable: true })
  archivedFromStatus!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'datetime', insert: false, update: false })
  updatedAt!: Date;
}

@Entity('resource_links')
export class ResourceLink {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  @Column({ name: 'source_type', type: 'varchar', length: 32 })
  sourceType!: string;

  @Column({ name: 'source_id', type: 'int', unsigned: true })
  sourceId!: number;

  @Column({ type: 'varchar', length: 48 })
  relation!: string;

  @Column({ name: 'target_type', type: 'varchar', length: 32 })
  targetType!: string;

  @Column({ name: 'target_id', type: 'int', unsigned: true })
  targetId!: number;

  /** 手动关联的属性：有效期起止（YYYY-MM-DD）与用途 */
  @Column({ name: 'valid_from', type: 'date', nullable: true })
  validFrom!: string | null;

  @Column({ name: 'valid_to', type: 'date', nullable: true })
  validTo!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  purpose!: string | null;

  /** 关系类型：使用/授权/保管/其他（旧数据为空） */
  @Column({ name: 'relation_kind', type: 'varchar', length: 16, nullable: true })
  relationKind!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

@Entity('resource_change_logs')
export class ResourceChangeLog {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  @Column({ name: 'resource_type', type: 'varchar', length: 32 })
  resourceType!: string;

  @Column({ name: 'resource_id', type: 'int', unsigned: true })
  resourceId!: number;

  @Column({ type: 'varchar', length: 24 })
  action!: string;

  @Column({ name: 'actor_id', type: 'int', unsigned: true, nullable: true })
  actorId!: number | null;

  @Column({ name: 'before_json', type: 'json', nullable: true })
  beforeJson!: Record<string, unknown> | null;

  @Column({ name: 'after_json', type: 'json', nullable: true })
  afterJson!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}

@Entity('integration_settings')
@Index('uq_integration_setting', ['companyId', 'settingKey'], { unique: true })
export class IntegrationSetting {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  @Column({ name: 'setting_key', type: 'varchar', length: 32 })
  settingKey!: string;

  /** 整份配置 JSON 加密后的密文 */
  @Column({ name: 'config_enc', type: 'text' })
  configEnc!: string;

  @Column({ name: 'updated_by', type: 'int', unsigned: true, nullable: true })
  updatedBy!: number | null;

  @Column({ name: 'updated_at', type: 'datetime', insert: false, update: false })
  updatedAt!: Date;
}

@Entity('resource_files')
export class ResourceFile {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id!: number;

  @Column({ name: 'company_id', type: 'int', unsigned: true })
  companyId!: number;

  @Column({ name: 'resource_type', type: 'varchar', length: 32 })
  resourceType!: string;

  /** 上传后、记录保存前为空；保存记录时绑定 */
  @Column({ name: 'resource_id', type: 'int', unsigned: true, nullable: true })
  resourceId!: number | null;

  @Column({ name: 'field_key', type: 'varchar', length: 48 })
  fieldKey!: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 300 })
  storageKey!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 64 })
  mime!: string;

  @Column({ type: 'int', unsigned: true })
  size!: number;

  @Column({ name: 'uploaded_by', type: 'int', unsigned: true, nullable: true })
  uploadedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}


/** 财务单据（头）。状态 draft → issued → posted → reversed；红冲单 reverses_id 指向原单。 */
@Entity('finance_documents')
export class FinanceDocument {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'doc_no', type: 'varchar', length: 32 }) docNo!: string;
  @Column({ name: 'doc_type', type: 'varchar', length: 24 }) docType!: string;
  @Column({ type: 'varchar', length: 12, default: 'draft' }) status!: 'draft' | 'issued' | 'posted' | 'reversed';
  @Column({ name: 'doc_date', type: 'date' }) docDate!: string;
  @Column({ name: 'party_id', type: 'int', unsigned: true, nullable: true }) partyId!: number | null;
  @Column({ name: 'party_kind', type: 'varchar', length: 12, nullable: true }) partyKind!: string | null;
  @Column({ name: 'bank_account_id', type: 'int', unsigned: true, nullable: true }) bankAccountId!: number | null;
  @Column({ name: 'to_bank_account_id', type: 'int', unsigned: true, nullable: true }) toBankAccountId!: number | null;
  @Column({ name: 'warehouse_id', type: 'int', unsigned: true, nullable: true }) warehouseId!: number | null;
  @Column({ name: 'store_id', type: 'int', unsigned: true, nullable: true }) storeId!: number | null;
  @Column({ name: 'ref_no', type: 'varchar', length: 80, nullable: true }) refNo!: string | null;
  @Column({ name: 'amount_cents', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } }) amountCents!: number;
  @Column({ name: 'offset_cents', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } }) offsetCents!: number;
  @Column({ name: 'paid_cents', type: 'bigint', default: 0, transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } }) paidCents!: number;
  @Column({ name: 'discount_cents', type: 'bigint', default: 0, transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } }) discountCents!: number;
  @Column({ name: 'settle_by', type: 'varchar', length: 8, nullable: true }) settleBy!: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) memo!: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) handler!: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) department!: string | null;
  @Column({ name: 'source_key', type: 'varchar', length: 120, nullable: true }) sourceKey!: string | null;
  @Column({ name: 'reverses_id', type: 'int', unsigned: true, nullable: true }) reversesId!: number | null;
  @Column({ name: 'reversed_by_id', type: 'int', unsigned: true, nullable: true }) reversedById!: number | null;
  @Column({ name: 'created_by', type: 'int', unsigned: true }) createdBy!: number;
  @Column({ name: 'issued_at', type: 'datetime', nullable: true }) issuedAt!: Date | null;
  @Column({ name: 'posted_at', type: 'datetime', nullable: true }) postedAt!: Date | null;
  @Column({ name: 'audited_by', type: 'int', unsigned: true, nullable: true }) auditedBy!: number | null;
  @Column({ name: 'audited_at', type: 'datetime', nullable: true }) auditedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'datetime', insert: false, update: false }) updatedAt!: Date;
}

@Entity('finance_document_lines')
export class FinanceDocumentLine {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'document_id', type: 'int', unsigned: true }) documentId!: number;
  @Column({ name: 'line_no', type: 'int' }) lineNo!: number;
  @Column({ name: 'product_id', type: 'int', unsigned: true, nullable: true }) productId!: number | null;
  @Column({ name: 'fee_item_id', type: 'int', unsigned: true, nullable: true }) feeItemId!: number | null;
  @Column({ type: 'decimal', precision: 18, scale: 4, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } }) qty!: number;
  @Column({ name: 'unit_price_cents', type: 'decimal', precision: 24, scale: 4, transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } }) unitPriceCents!: number;
  @Column({ name: 'unit_cost_cents', type: 'decimal', precision: 24, scale: 4, nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | number | null) => (v === null ? null : Number(v)) } }) unitCostCents!: number | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) memo!: string | null;
  @Column({ name: 'related_node', type: 'varchar', length: 20, nullable: true }) relatedNode!: string | null;
  @Column({ name: 'related_id', type: 'int', unsigned: true, nullable: true }) relatedId!: number | null;
  @Column({ name: 'related_name', type: 'varchar', length: 100, nullable: true }) relatedName!: string | null;
  @Column({ name: 'item_name', type: 'varchar', length: 100, nullable: true }) itemName!: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) unit!: string | null;
}

@Entity('finance_document_accounts')
export class FinanceDocumentAccount {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'document_id', type: 'int', unsigned: true }) documentId!: number;
  @Column({ type: 'varchar', length: 4 }) role!: 'out' | 'in';
  @Column({ name: 'bank_account_id', type: 'int', unsigned: true }) bankAccountId!: number;
  @Column({ name: 'amount_cents', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } }) amountCents!: number;
}

@Entity('finance_document_settlements')
export class FinanceDocumentSettlement {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'document_id', type: 'int', unsigned: true }) documentId!: number;
  @Column({ name: 'source_document_id', type: 'int', unsigned: true }) sourceDocumentId!: number;
  @Column({ name: 'product_id', type: 'int', unsigned: true, nullable: true }) productId!: number | null;
  @Column({ name: 'amount_cents', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } }) amountCents!: number;
}

@Entity('finance_cost_snapshots')
export class FinanceCostSnapshot {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'bundle_id', type: 'int', unsigned: true }) bundleId!: number;
  @Column({ type: 'varchar', length: 120 }) code!: string;
  @Column({ type: 'varchar', length: 300 }) name!: string;
  @Column({ type: 'int', unsigned: true }) revision!: number;
  @Column({ name: 'pre_ship_cost_cents', type: 'decimal', precision: 24, scale: 4, nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } }) preShipCostCents!: number | null;
  @Column({ name: 'weight_g', type: 'decimal', precision: 14, scale: 2, nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } }) weightG!: number | null;
  @Column({ name: 'freight_cents', type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } }) freightCents!: number | null;
  @Column({ name: 'margin_percent', type: 'decimal', precision: 10, scale: 6, nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } }) marginPercent!: number | null;
  @Column({ name: 'min_price_cents', type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } }) minPriceCents!: number | null;
  @Column({ type: 'varchar', length: 200, default: '' }) reason!: string;
  /** 事件类型：workflow_publish 验证发布 / pricing_update 维护售价 / source_values_update 来源值变化 / manual 手动登记 */
  @Column({ name: 'event_type', type: 'varchar', length: 24, default: 'manual' }) eventType!: string;
  @Column({ name: 'actor_id', type: 'int', unsigned: true, nullable: true }) actorId!: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' }) createdAt!: Date;
}

@Entity('finance_api_keys')
export class FinanceApiKey {
  @PrimaryColumn({ type: 'char', length: 36 }) id!: string;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ type: 'varchar', length: 100 }) name!: string;
  @Column({ type: 'varchar', length: 40 }) scope!: string;
  @Column({ name: 'key_hash', type: 'char', length: 64 }) keyHash!: string;
  @Column({ name: 'created_by', type: 'int', unsigned: true, nullable: true }) createdBy!: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' }) createdAt!: Date;
  @Column({ name: 'last_used_at', type: 'datetime', nullable: true }) lastUsedAt!: Date | null;
  @Column({ name: 'revoked_by', type: 'int', unsigned: true, nullable: true }) revokedBy!: number | null;
  @Column({ name: 'revoked_at', type: 'datetime', nullable: true }) revokedAt!: Date | null;
}

@Entity('finance_master_snapshots')
export class FinanceMasterSnapshot {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ type: 'varchar', length: 16 }) operation!: string;
  @Column({ type: 'varchar', length: 200 }) label!: string;
  @Column({ name: 'scope_json', type: 'json' }) scopeJson!: Record<string, unknown>;
  @Column({ name: 'snapshot_json', type: 'longtext' }) snapshotJson!: string;
  @Column({ name: 'row_count', type: 'int', unsigned: true }) rowCount!: number;
  @Column({ name: 'created_by', type: 'int', unsigned: true, nullable: true }) createdBy!: number | null;
  @Column({ name: 'restored_at', type: 'datetime', nullable: true }) restoredAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' }) createdAt!: Date;
}

@Entity('outbox_jobs')
export class OutboxJob {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ type: 'varchar', length: 24 }) channel!: string;
  @Column({ type: 'varchar', length: 32 }) kind!: string;
  @Column({ name: 'resource_type', type: 'varchar', length: 32 }) resourceType!: string;
  @Column({ name: 'resource_id', type: 'int', unsigned: true }) resourceId!: number;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 120 }) idempotencyKey!: string;
  @Column({ name: 'payload_json', type: 'json' }) payloadJson!: Record<string, unknown>;
  @Column({ type: 'varchar', length: 12, default: 'pending' }) status!: 'pending' | 'sending' | 'done' | 'failed' | 'cancelled';
  @Column({ type: 'int', unsigned: true, default: 0 }) attempts!: number;
  @Column({ name: 'next_attempt_at', type: 'datetime' }) nextAttemptAt!: Date;
  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true }) lastError!: string | null;
  @Column({ name: 'created_by', type: 'int', unsigned: true, nullable: true }) createdBy!: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' }) createdAt!: Date;
  @Column({ name: 'done_at', type: 'datetime', nullable: true }) doneAt!: Date | null;
}

@Entity('resource_import_backups')
export class ResourceImportBackup {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'resource_type', type: 'varchar', length: 32 }) resourceType!: string;
  @Column({ name: 'record_count', type: 'int', unsigned: true, default: 0 }) recordCount!: number;
  @Column({ name: 'snapshot_json', type: 'longtext' }) snapshotJson!: string;
  @Column({ name: 'created_by', type: 'int', unsigned: true, nullable: true }) createdBy!: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' }) createdAt!: Date;
  @Column({ name: 'restored_at', type: 'datetime', nullable: true }) restoredAt!: Date | null;
}

@Entity('finance_fee_snapshots')
export class FeeArchiveSnapshot {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ type: 'varchar', length: 120 }) name!: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) remark!: string | null;
  @Column({ type: 'tinyint', width: 1, default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number | boolean) => v === 1 || v === true } }) auto!: boolean;
  @Column({ name: 'category_count', type: 'int', unsigned: true, default: 0 }) categoryCount!: number;
  @Column({ name: 'item_count', type: 'int', unsigned: true, default: 0 }) itemCount!: number;
  @Column({ name: 'snapshot_json', type: 'longtext' }) snapshotJson!: string;
  @Column({ name: 'created_by', type: 'int', unsigned: true, nullable: true }) createdBy!: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' }) createdAt!: Date;
  @Column({ name: 'restored_at', type: 'datetime', nullable: true }) restoredAt!: Date | null;
}

@Entity('outbox_switches')
export class OutboxSwitch {
  @PrimaryColumn({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @PrimaryColumn({ type: 'varchar', length: 24 }) channel!: string;
  @Column({ type: 'tinyint', width: 1, default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number | boolean) => v === 1 || v === true } }) enabled!: boolean;
  @Column({ type: 'varchar', length: 200, nullable: true }) note!: string | null;
  @Column({ name: 'updated_by', type: 'int', unsigned: true, nullable: true }) updatedBy!: number | null;
  @Column({ name: 'updated_at', type: 'datetime', insert: false, update: false }) updatedAt!: Date;
}

@Entity('finance_entries')
export class FinanceEntry {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true }) id!: string;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'document_id', type: 'int', unsigned: true }) documentId!: number;
  @Column({ name: 'entry_date', type: 'date' }) entryDate!: string;
  @Column({ type: 'varchar', length: 20 }) kind!: string;
  @Column({ name: 'account_id', type: 'int', unsigned: true, default: 0 }) accountId!: number;
  @Column({ name: 'sub_id', type: 'int', unsigned: true, default: 0 }) subId!: number;
  @Column({ name: 'amount_cents', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } }) amountCents!: number;
  @Column({ type: 'decimal', precision: 18, scale: 4, nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } }) qty!: number | null;
}

@Entity('finance_document_events')
export class FinanceDocumentEvent {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'document_id', type: 'int', unsigned: true }) documentId!: number;
  @Column({ type: 'varchar', length: 16 }) action!: string;
  @Column({ name: 'actor_id', type: 'int', unsigned: true }) actorId!: number;
  @Column({ type: 'varchar', length: 500, nullable: true }) note!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' }) createdAt!: Date;
}


const dt = { type: 'datetime' as const };

/** 流程定义：每个模板每个公司有版本；active 的那个用来发起新流程，发布后不可改。 */
@Entity('flow_definitions')
export class FlowDefinition {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'template_key', type: 'varchar', length: 40 }) templateKey!: string;
  @Column({ type: 'int', unsigned: true }) version!: number;
  @Column({ type: 'varchar', length: 10, default: 'draft' }) status!: 'draft' | 'active' | 'retired';
  @Column({ type: 'json' }) steps!: unknown[];
  /** 自建模板的表单结构（fields/stepFields/posting）；内置模板为空 */
  @Column({ name: 'schema_json', type: 'json', nullable: true }) schemaJson!: Record<string, unknown> | null;
  @Column({ name: 'escalate_user_ids', type: 'json' }) escalateUserIds!: number[];
  @Column({ name: 'created_by', type: 'int', unsigned: true }) createdBy!: number;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'published_at', ...dt, nullable: true }) publishedAt!: Date | null;
}

/** 公司自建流程模板的身份与目录属性（步骤和表单结构在 flow_definitions 的版本里） */
@Entity('flow_templates')
export class FlowTemplateRow {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'template_key', type: 'varchar', length: 40 }) templateKey!: string;
  @Column({ type: 'varchar', length: 100 }) name!: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) description!: string | null;
  @Column({ name: 'department_id', type: 'int', unsigned: true, nullable: true }) departmentId!: number | null;
  @Column({ name: 'source_key', type: 'varchar', length: 40, nullable: true }) sourceKey!: string | null;
  @Column({ name: 'created_by', type: 'int', unsigned: true }) createdBy!: number;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'updated_at', ...dt, insert: false, update: false }) updatedAt!: Date;
}

/** 公司自定义的节点模板（内置节点模板在 shared 代码里） */
@Entity('flow_node_templates')
export class FlowNodeTemplate {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'node_key', type: 'varchar', length: 40 }) nodeKey!: string;
  @Column({ type: 'varchar', length: 40 }) name!: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) description!: string | null;
  @Column({ type: 'varchar', length: 20 }) category!: string;
  @Column({ name: 'step_type', type: 'varchar', length: 12 }) stepType!: string;
  @Column({ name: 'due_minutes', type: 'int', unsigned: true, nullable: true }) dueMinutes!: number | null;
  @Column({ type: 'json' }) fields!: unknown[];
  @Column({ name: 'source_key', type: 'varchar', length: 40, nullable: true }) sourceKey!: string | null;
  @Column({ type: 'int', unsigned: true, default: 1 }) revision!: number;
  @Column({ name: 'created_by', type: 'int', unsigned: true }) createdBy!: number;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'updated_at', ...dt, insert: false, update: false }) updatedAt!: Date;
}

@Entity('flow_runs')
export class FlowRun {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'definition_id', type: 'int', unsigned: true }) definitionId!: number;
  @Column({ name: 'template_key', type: 'varchar', length: 40 }) templateKey!: string;
  @Column({ type: 'varchar', length: 200 }) title!: string;
  @Column({ type: 'varchar', length: 12, default: 'running' }) status!: 'running' | 'completed' | 'cancelled' | 'rejected';
  @Column({ name: 'requester_id', type: 'int', unsigned: true }) requesterId!: number;
  @Column({ name: 'current_step_key', type: 'varchar', length: 32, nullable: true }) currentStepKey!: string | null;
  @Column({ type: 'json' }) payload!: Record<string, unknown>;
  @Column({ name: 'steps_snapshot', type: 'json' }) stepsSnapshot!: unknown[];
  @Column({ name: 'escalate_user_ids', type: 'json' }) escalateUserIds!: number[];
  @Column({ type: 'int', unsigned: true, default: 1 }) revision!: number;
  @Column({ name: 'due_at', ...dt, nullable: true }) dueAt!: Date | null;
  @Column({ name: 'request_key', type: 'varchar', length: 80, nullable: true }) requestKey!: string | null;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'updated_at', ...dt, insert: false, update: false }) updatedAt!: Date;
  @Column({ name: 'finished_at', ...dt, nullable: true }) finishedAt!: Date | null;
}

@Entity('flow_steps')
export class FlowStep {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'run_id', type: 'int', unsigned: true }) runId!: number;
  @Column({ type: 'int', unsigned: true }) seq!: number;
  @Column({ name: 'step_key', type: 'varchar', length: 32 }) stepKey!: string;
  @Column({ name: 'step_name', type: 'varchar', length: 40 }) stepName!: string;
  @Column({ name: 'step_type', type: 'varchar', length: 12 }) stepType!: string;
  @Column({ type: 'varchar', length: 12, default: 'active' }) status!: 'active' | 'done' | 'returned' | 'cancelled' | 'rejected' | 'transferred' | 'skipped';
  @Column({ name: 'entered_via', type: 'varchar', length: 12, default: 'normal' }) enteredVia!: string;
  @Column({ type: 'json' }) recipients!: number[];
  @Column({ name: 'handled_by', type: 'int', unsigned: true, nullable: true }) handledBy!: number | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) action!: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) comment!: string | null;
  @Column({ type: 'json', nullable: true }) form!: Record<string, unknown> | null;
  @Column({ name: 'entered_at', ...dt, default: () => 'CURRENT_TIMESTAMP' }) enteredAt!: Date;
  @Column({ name: 'finished_at', ...dt, nullable: true }) finishedAt!: Date | null;
  @Column({ name: 'due_at', ...dt, nullable: true }) dueAt!: Date | null;
}

/** 待办：每个接收人一行；部门共享时同一步 N 行，任一人办理后其余自动关闭。 */
@Entity('work_items')
export class WorkItem {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ type: 'varchar', length: 12, default: 'flow' }) kind!: string;
  @Column({ name: 'run_id', type: 'int', unsigned: true, nullable: true }) runId!: number | null;
  @Column({ name: 'step_id', type: 'int', unsigned: true, nullable: true }) stepId!: number | null;
  @Column({ name: 'assignee_id', type: 'int', unsigned: true }) assigneeId!: number;
  @Column({ name: 'created_by', type: 'int', unsigned: true, nullable: true }) createdBy!: number | null;
  @Column({ name: 'routine_id', type: 'int', unsigned: true, nullable: true }) routineId!: number | null;
  @Column({ name: 'schedule_key', type: 'varchar', length: 80, nullable: true }) scheduleKey!: string | null;
  @Column({ type: 'varchar', length: 200 }) title!: string;
  @Column({ type: 'varchar', length: 1000, nullable: true }) description!: string | null;
  @Column({ type: 'varchar', length: 10, default: 'open' }) status!: 'open' | 'done' | 'cancelled';
  @Column({ name: 'supervisor_id', type: 'int', unsigned: true, nullable: true }) supervisorId!: number | null;
  @Column({ name: 'requires_review', type: 'tinyint', width: 1, default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 } }) requiresReview!: boolean;
  @Column({ name: 'feedback_preset', type: 'varchar', length: 30, nullable: true }) feedbackPreset!: string | null;
  @Column({ name: 'completion_standard', type: 'varchar', length: 500, nullable: true }) completionStandard!: string | null;
  @Column({ name: 'submit_payload', type: 'json', nullable: true }) submitPayload!: Record<string, unknown> | null;
  /** 异常提交：负责人没办成/发现问题提交，等监督人处理（和“已提交待复核”一样靠 submitted_at 表示已提交） */
  @Column({ name: 'is_abnormal', type: 'tinyint', width: 1, default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 } }) isAbnormal!: boolean;
  @Column({ name: 'due_at', ...dt, nullable: true }) dueAt!: Date | null;
  @Column({ name: 'overdue_notified_at', ...dt, nullable: true }) overdueNotifiedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'finished_at', ...dt, nullable: true }) finishedAt!: Date | null;
  @Column({ name: 'done_note', type: 'varchar', length: 500, nullable: true }) doneNote!: string | null;
  /** 个人任务：负责人点“开始处理”的时间 */
  @Column({ name: 'started_at', ...dt, nullable: true }) startedAt!: Date | null;
  /** 个人任务：负责人提交给指派人复核的时间；复核退回后清空 */
  @Column({ name: 'submitted_at', ...dt, nullable: true }) submittedAt!: Date | null;
  @Column({ name: 'review_note', type: 'varchar', length: 500, nullable: true }) reviewNote!: string | null;
}

/** 周期任务：到点自动给负责人生成一条待办。 */
@Entity('task_routines')
export class TaskRoutine {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ type: 'varchar', length: 150 }) title!: string;
  @Column({ type: 'varchar', length: 1000, nullable: true }) description!: string | null;
  @Column({ name: 'assignee_id', type: 'int', unsigned: true }) assigneeId!: number;
  @Column({ name: 'supervisor_id', type: 'int', unsigned: true, nullable: true }) supervisorId!: number | null;
  @Column({ name: 'requires_review', type: 'tinyint', width: 1, default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 } }) requiresReview!: boolean;
  @Column({ name: 'feedback_preset', type: 'varchar', length: 30, nullable: true }) feedbackPreset!: string | null;
  @Column({ name: 'completion_standard', type: 'varchar', length: 500, nullable: true }) completionStandard!: string | null;
  @Column({ type: 'varchar', length: 8 }) frequency!: 'daily' | 'weekly' | 'monthly';
  @Column({ type: 'tinyint', unsigned: true, nullable: true }) weekday!: number | null;
  @Column({ name: 'month_day', type: 'tinyint', unsigned: true, nullable: true }) monthDay!: number | null;
  @Column({ name: 'due_days', type: 'tinyint', unsigned: true, default: 1 }) dueDays!: number;
  @Column({ type: 'tinyint', width: 1, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 } }) active!: boolean;
  @Column({ name: 'created_by', type: 'int', unsigned: true }) createdBy!: number;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
}

/** 任务延期申请：负责人申请，监督人（没有监督人时是指派人）同意后任务截止时间改成新的。 */
@Entity('task_delay_requests')
export class TaskDelayRequest {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'work_item_id', type: 'int', unsigned: true }) workItemId!: number;
  @Column({ name: 'requester_id', type: 'int', unsigned: true }) requesterId!: number;
  @Column({ name: 'approver_id', type: 'int', unsigned: true }) approverId!: number;
  @Column({ name: 'old_due_at', ...dt, nullable: true }) oldDueAt!: Date | null;
  @Column({ name: 'requested_due_at', ...dt }) requestedDueAt!: Date;
  @Column({ type: 'varchar', length: 500 }) reason!: string;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status!: 'pending' | 'approved' | 'rejected';
  @Column({ name: 'approval_comment', type: 'varchar', length: 500, nullable: true }) approvalComment!: string | null;
  @Column({ name: 'decided_at', ...dt, nullable: true }) decidedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
}

@Entity('flow_ccs')
export class FlowCc {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'run_id', type: 'int', unsigned: true }) runId!: number;
  @Column({ name: 'user_id', type: 'int', unsigned: true }) userId!: number;
  @Column({ name: 'step_key', type: 'varchar', length: 32 }) stepKey!: string;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
}

@Entity('flow_events')
export class FlowEvent {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'run_id', type: 'int', unsigned: true }) runId!: number;
  @Column({ name: 'step_id', type: 'int', unsigned: true, nullable: true }) stepId!: number | null;
  @Column({ name: 'actor_id', type: 'int', unsigned: true }) actorId!: number;
  @Column({ type: 'varchar', length: 12 }) action!: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) note!: string | null;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
}

/** 站内通知：按员工隔离，可标已读（旧系统的铃铛是死功能，这里补齐）。 */
@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'user_id', type: 'int', unsigned: true }) userId!: number;
  @Column({ type: 'varchar', length: 20 }) kind!: string;
  @Column({ type: 'varchar', length: 200 }) title!: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) body!: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) link!: string | null;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'read_at', ...dt, nullable: true }) readAt!: Date | null;
}

/** 店铺登录管理：授权电脑（助手）。 */
@Entity('session_devices')
export class SessionDevice {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'device_no', type: 'char', length: 12 }) deviceNo!: string;
  @Column({ type: 'varchar', length: 80 }) name!: string;
  @Column({ type: 'varchar', length: 60, nullable: true }) os!: string | null;
  @Column({ name: 'agent_version', type: 'varchar', length: 30, nullable: true }) agentVersion!: string | null;
  @Column({ name: 'update_target', type: 'varchar', length: 30, nullable: true }) updateTarget!: string | null;
  @Column({ name: 'update_status', type: 'varchar', length: 12, nullable: true }) updateStatus!: 'queued' | 'downloading' | 'verifying' | 'staged' | 'applying' | 'restarting' | 'succeeded' | 'failed' | 'rolled_back' | null;
  @Column({ name: 'update_error', type: 'varchar', length: 300, nullable: true }) updateError!: string | null;
  @Column({ name: 'update_requested_at', ...dt, nullable: true }) updateRequestedAt!: Date | null;
  @Column({ name: 'token_hash', type: 'char', length: 64 }) tokenHash!: string;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status!: 'active' | 'revoked' | 'deleted';
  @Column({ name: 'last_seen_at', ...dt, nullable: true }) lastSeenAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
}

@Entity('session_bind_codes')
export class SessionBindCode {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'code_hash', type: 'char', length: 64 }) codeHash!: string;
  @Column({ name: 'expires_at', ...dt }) expiresAt!: Date;
  @Column({ name: 'used_at', ...dt, nullable: true }) usedAt!: Date | null;
  @Column({ name: 'created_by', type: 'int', unsigned: true }) createdBy!: number;
}

/** 托管店铺：提现要登录的店铺，登录账号密码加密保存。 */
@Entity('session_shops')
export class SessionShop {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ type: 'varchar', length: 30, default: 'finance_withdrawal' }) workspace!: string;
  @Column({ name: 'store_id', type: 'int', unsigned: true }) storeId!: number;
  @Column({ name: 'device_id', type: 'int', unsigned: true, nullable: true }) deviceId!: number | null;
  @Column({ name: 'login_account', type: 'varchar', length: 100, nullable: true }) loginAccount!: string | null;
  @Column({ name: 'login_password_enc', type: 'text', nullable: true }) loginPasswordEnc!: string | null;
  @Column({ name: 'auto_login', type: 'tinyint', width: 1, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 } }) autoLogin!: boolean;
  @Column({ name: 'login_state', type: 'varchar', length: 10, default: 'none' }) loginState!: 'none' | 'valid' | 'expired' | 'error';
  @Column({ name: 'last_verified_at', ...dt, nullable: true }) lastVerifiedAt!: Date | null;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status!: 'active' | 'removed';
}

@Entity('session_open_requests')
export class SessionOpenRequest {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'shop_id', type: 'int', unsigned: true }) shopId!: number;
  @Column({ name: 'device_id', type: 'int', unsigned: true }) deviceId!: number;
  @Column({ type: 'varchar', length: 8 }) kind!: 'first' | 'now' | 'capture';
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status!: 'pending' | 'claimed' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  @Column({ name: 'error_code', type: 'varchar', length: 40, nullable: true }) errorCode!: string | null;
  @Column({ name: 'error_text', type: 'varchar', length: 300, nullable: true }) errorText!: string | null;
  @Column({ name: 'file_id', type: 'int', unsigned: true, nullable: true }) fileId!: number | null;
  @Column({ name: 'requested_by', type: 'int', unsigned: true }) requestedBy!: number;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'claimed_at', ...dt, nullable: true }) claimedAt!: Date | null;
  @Column({ name: 'finished_at', ...dt, nullable: true }) finishedAt!: Date | null;
}

@Entity('session_audit_logs')
export class SessionAuditLog {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'event_type', type: 'varchar', length: 50 }) eventType!: string;
  @Column({ type: 'varchar', length: 500 }) summary!: string;
  @Column({ name: 'actor_id', type: 'int', unsigned: true, nullable: true }) actorId!: number | null;
  @Column({ name: 'device_id', type: 'int', unsigned: true, nullable: true }) deviceId!: number | null;
  @Column({ name: 'store_id', type: 'int', unsigned: true, nullable: true }) storeId!: number | null;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
}

/** 远程协助：电脑是否开启（没有这一行 = 关闭）。 */
@Entity('session_remote_devices')
export class SessionRemoteDevice {
  @PrimaryColumn({ name: 'device_id', type: 'int', unsigned: true }) deviceId!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ type: 'tinyint', width: 1, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 } }) enabled!: boolean;
  @Column({ name: 'allow_control', type: 'tinyint', width: 1, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 } }) allowControl!: boolean;
  @Column({ name: 'max_minutes', type: 'smallint', unsigned: true, default: 15 }) maxMinutes!: number;
  @Column({ name: 'updated_by', type: 'int', unsigned: true, nullable: true }) updatedBy!: number | null;
  @Column({ name: 'updated_at', ...dt }) updatedAt!: Date;
}

/** 远程协助：每一次协助的记录（审计用，不删除）。 */
@Entity('session_remote_sessions')
export class SessionRemoteSession {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'shop_id', type: 'int', unsigned: true }) shopId!: number;
  @Column({ name: 'store_id', type: 'int', unsigned: true }) storeId!: number;
  @Column({ name: 'device_id', type: 'int', unsigned: true }) deviceId!: number;
  @Column({ name: 'requested_by', type: 'int', unsigned: true }) requestedBy!: number;
  @Column({ type: 'varchar', length: 8 }) mode!: 'view' | 'control';
  @Column({ type: 'varchar', length: 100 }) reason!: string;
  @Column({ type: 'varchar', length: 10, default: 'requested' }) status!: 'requested' | 'active' | 'ended';
  @Column({ name: 'end_reason', type: 'varchar', length: 20, nullable: true }) endReason!: string | null;
  @Column({ name: 'end_note', type: 'varchar', length: 300, nullable: true }) endNote!: string | null;
  @Column({ name: 'ended_by', type: 'int', unsigned: true, nullable: true }) endedBy!: number | null;
  @Column({ name: 'max_minutes', type: 'smallint', unsigned: true }) maxMinutes!: number;
  @Column({ name: 'extend_count', type: 'tinyint', unsigned: true, default: 0 }) extendCount!: number;
  @Column({ name: 'input_count', type: 'int', unsigned: true, default: 0 }) inputCount!: number;
  @Column({ name: 'requested_at', ...dt }) requestedAt!: Date;
  @Column({ name: 'deadline_at', ...dt }) deadlineAt!: Date;
  @Column({ name: 'accepted_at', ...dt, nullable: true }) acceptedAt!: Date | null;
  @Column({ name: 'expires_at', ...dt, nullable: true }) expiresAt!: Date | null;
  @Column({ name: 'ended_at', ...dt, nullable: true }) endedAt!: Date | null;
  @Column({ name: 'viewer_seen_at', ...dt, nullable: true }) viewerSeenAt!: Date | null;
  @Column({ name: 'agent_seen_at', ...dt, nullable: true }) agentSeenAt!: Date | null;
}

/** 远程协助：WebRTC 信令信箱，会话结束即清空。 */
@Entity('session_remote_signals')
export class SessionRemoteSignal {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'session_id', type: 'int', unsigned: true }) sessionId!: number;
  @Column({ name: 'to_agent', type: 'tinyint', width: 1, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 } }) toAgent!: boolean;
  @Column({ type: 'varchar', length: 10 }) kind!: string;
  @Column({ type: 'mediumtext' }) payload!: string;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
}

/** 表单草稿：每人每个草稿标识一份（草稿只给本人看，内容就是还没保存的表单值）。 */
@Entity('form_drafts')
export class FormDraft {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'user_id', type: 'int', unsigned: true }) userId!: number;
  @Column({ name: 'draft_key', type: 'varchar', length: 190 }) draftKey!: string;
  @Column({ name: 'module_key', type: 'varchar', length: 80 }) moduleKey!: string;
  @Column({ type: 'varchar', length: 200, default: '' }) title!: string;
  @Column({ name: 'source_record_id', type: 'varchar', length: 40, nullable: true }) sourceRecordId!: string | null;
  @Column({ type: 'json' }) payload!: Record<string, unknown>;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'updated_at', ...dt, insert: false, update: false }) updatedAt!: Date;
}

/** 手机扫码上传会话：令牌只存哈希；绑定公司、发起人、资料类型和字段；短期有效、限次数。 */
@Entity('phone_upload_sessions')
export class PhoneUploadSession {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'token_hash', type: 'char', length: 64 }) tokenHash!: string;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'user_id', type: 'int', unsigned: true }) userId!: number;
  @Column({ name: 'resource_type', type: 'varchar', length: 40 }) resourceType!: string;
  @Column({ name: 'field_key', type: 'varchar', length: 48 }) fieldKey!: string;
  @Column({ name: 'max_uploads', type: 'tinyint', unsigned: true }) maxUploads!: number;
  @Column({ name: 'upload_count', type: 'tinyint', unsigned: true, default: 0 }) uploadCount!: number;
  @Column({ name: 'file_ids', type: 'json' }) fileIds!: number[];
  @Column({ name: 'expires_at', ...dt }) expiresAt!: Date;
  @Column({ name: 'scanned_at', ...dt, nullable: true }) scannedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
}

/** 基础编码验证事件：每次验证通过追加一行（旧 finance_product_data_verification_events），只增不改。 */
@Entity('finance_product_data_verification_events')
export class ProductVerificationEvent {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true }) id!: string;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'base_code_id', type: 'int', unsigned: true }) baseCodeId!: number;
  @Column({ name: 'composition_signature', type: 'varchar', length: 64 }) compositionSignature!: string;
  @Column({ name: 'verified_by', type: 'int', unsigned: true, nullable: true }) verifiedBy!: number | null;
  @CreateDateColumn({ name: 'verified_at', ...dt }) verifiedAt!: Date;
  @Column({ name: 'snapshot_json', type: 'json', nullable: true }) snapshotJson!: Record<string, unknown> | null;
}

/** 售后工单：内容与凭证在这里，流转在 flow_runs（run_id）。 */
@Entity('after_sales_cases')
export class AfterSalesCase {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'case_no', type: 'varchar', length: 32, nullable: true }) caseNo!: string | null;
  @Column({ name: 'run_id', type: 'int', unsigned: true }) runId!: number;
  @Column({ name: 'store_id', type: 'int', unsigned: true }) storeId!: number;
  @Column({ name: 'order_no', type: 'varchar', length: 80 }) orderNo!: string;
  @Column({ name: 'buyer_name', type: 'varchar', length: 80, nullable: true }) buyerName!: string | null;
  @Column({ name: 'case_type', type: 'varchar', length: 24 }) caseType!: string;
  @Column({ name: 'amount_cents', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } }) amountCents!: number;
  @Column({ name: 'refund_cents', type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } }) refundCents!: number | null;
  @Column({ type: 'varchar', length: 500 }) reason!: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) resolution!: string | null;
  @Column({ name: 'due_date', type: 'date', nullable: true }) dueDate!: string | null;
  @Column({ type: 'varchar', length: 16, default: 'manual' }) source!: string;
  @Column({ name: 'source_key', type: 'varchar', length: 100, nullable: true }) sourceKey!: string | null;
  @Column({ type: 'json', nullable: true }) attachments!: number[] | null;
  @Column({ name: 'created_by', type: 'int', unsigned: true }) createdBy!: number;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'finished_at', ...dt, nullable: true }) finishedAt!: Date | null;
}

/** 订单申诉：申诉内容、凭证、平台单号与结果；流转在 flow_runs。 */
@Entity('order_appeals')
export class OrderAppeal {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'appeal_no', type: 'varchar', length: 32, nullable: true }) appealNo!: string | null;
  @Column({ name: 'run_id', type: 'int', unsigned: true }) runId!: number;
  @Column({ name: 'store_id', type: 'int', unsigned: true }) storeId!: number;
  @Column({ name: 'appeal_type', type: 'varchar', length: 24 }) appealType!: string;
  @Column({ name: 'order_no', type: 'varchar', length: 80 }) orderNo!: string;
  @Column({ name: 'amount_cents', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } }) amountCents!: number;
  @Column({ type: 'varchar', length: 1000 }) reason!: string;
  @Column({ name: 'deadline_at', ...dt, nullable: true }) deadlineAt!: Date | null;
  @Column({ name: 'platform_appeal_no', type: 'varchar', length: 80, nullable: true }) platformAppealNo!: string | null;
  @Column({ name: 'submitted_at', type: 'date', nullable: true }) submittedAt!: string | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) result!: 'approved' | 'rejected' | null;
  @Column({ name: 'result_note', type: 'varchar', length: 500, nullable: true }) resultNote!: string | null;
  @Column({ name: 'parent_id', type: 'int', unsigned: true, nullable: true }) parentId!: number | null;
  @Column({ type: 'varchar', length: 16, default: 'manual' }) source!: string;
  @Column({ name: 'source_key', type: 'varchar', length: 100, nullable: true }) sourceKey!: string | null;
  @Column({ type: 'json', nullable: true }) evidence!: number[] | null;
  @Column({ name: 'created_by', type: 'int', unsigned: true }) createdBy!: number;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'finished_at', ...dt, nullable: true }) finishedAt!: Date | null;
}

/** 跟进记录（售后工单、申诉、监督异常共用）。 */
@Entity('case_logs')
export class CaseLog {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'target_type', type: 'varchar', length: 16 }) targetType!: string;
  @Column({ name: 'target_id', type: 'int', unsigned: true }) targetId!: number;
  @Column({ name: 'user_id', type: 'int', unsigned: true, nullable: true }) userId!: number | null;
  @Column({ type: 'varchar', length: 12, default: 'note' }) kind!: string;
  @Column({ type: 'varchar', length: 1000 }) content!: string;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
}

/** 兜底监督里的异常：逾期自动登记（source_key 幂等），也可手工登记；按逾期时长逐级升级。 */
@Entity('supervision_exceptions')
export class SupervisionException {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'source_type', type: 'varchar', length: 16 }) sourceType!: string;
  @Column({ name: 'source_id', type: 'int', unsigned: true, nullable: true }) sourceId!: number | null;
  @Column({ name: 'source_key', type: 'varchar', length: 80 }) sourceKey!: string;
  @Column({ name: 'run_id', type: 'int', unsigned: true, nullable: true }) runId!: number | null;
  @Column({ type: 'varchar', length: 200 }) title!: string;
  @Column({ type: 'varchar', length: 1000, nullable: true }) detail!: string | null;
  @Column({ type: 'varchar', length: 12, default: 'normal' }) severity!: 'urgent' | 'important' | 'normal';
  @Column({ type: 'varchar', length: 12, default: 'open' }) status!: 'open' | 'closed' | 'auto';
  @Column({ type: 'tinyint', unsigned: true, default: 1 }) level!: number;
  @Column({ name: 'owner_id', type: 'int', unsigned: true, nullable: true }) ownerId!: number | null;
  @Column({ name: 'store_id', type: 'int', unsigned: true, nullable: true }) storeId!: number | null;
  @Column({ name: 'due_at', ...dt, nullable: true }) dueAt!: Date | null;
  @Column({ name: 'close_reason', type: 'varchar', length: 500, nullable: true }) closeReason!: string | null;
  @Column({ name: 'closed_by', type: 'int', unsigned: true, nullable: true }) closedBy!: number | null;
  @Column({ name: 'closed_at', ...dt, nullable: true }) closedAt!: Date | null;
  @Column({ name: 'created_by', type: 'int', unsigned: true, nullable: true }) createdBy!: number | null;
  @CreateDateColumn({ name: 'created_at', ...dt }) createdAt!: Date;
  @Column({ name: 'escalated_at', ...dt, nullable: true }) escalatedAt!: Date | null;
}

@Entity('supervision_rules')
export class SupervisionRuleRow {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'target_type', type: 'varchar', length: 16 }) targetType!: string;
  @Column({ type: 'varchar', length: 100 }) name!: string;
  @Column({ name: 'overdue_minutes', type: 'int', unsigned: true, default: 0 }) overdueMinutes!: number;
  @Column({ name: 'supervisor_visible_minutes', type: 'int', unsigned: true, default: 0 }) supervisorVisibleMinutes!: number;
  @Column({ name: 'boss_visible_minutes', type: 'int', unsigned: true, default: 1440 }) bossVisibleMinutes!: number;
  @Column({ name: 'abnormal_condition', type: 'varchar', length: 240, default: '' }) abnormalCondition!: string;
  @Column({ name: 'close_requires_reason', type: 'tinyint', width: 1, default: 1, transformer: boolTransformer() }) closeRequiresReason!: boolean;
  @Column({ type: 'varchar', length: 12, default: 'active' }) status!: 'active' | 'inactive';
  @Column({ name: 'updated_by', type: 'int', unsigned: true, nullable: true }) updatedBy!: number | null;
  @Column({ name: 'updated_at', ...dt, default: () => 'CURRENT_TIMESTAMP' }) updatedAt!: Date;
}

/** 公司级资料分类选项：改名/排序（系统分类）、自建分类、隐藏。系统分类的行只在被改名或排序后才有。 */
@Entity('resource_category_options')
@Index('uq_resource_category', ['companyId', 'resourceType', 'fieldKey', 'value'], { unique: true })
export class ResourceCategoryOption {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Column({ name: 'resource_type', type: 'varchar', length: 64 }) resourceType!: string;
  @Column({ name: 'field_key', type: 'varchar', length: 48 }) fieldKey!: string;
  @Column({ type: 'varchar', length: 64 }) value!: string;
  @Column({ type: 'varchar', length: 60 }) label!: string;
  @Column({ name: 'sort_order', type: 'int', default: 0 }) sortOrder!: number;
  @Column({ type: 'tinyint', width: 1, default: 0, transformer: boolTransformer() }) hidden!: boolean;
  @Column({ type: 'tinyint', width: 1, default: 0, transformer: boolTransformer() }) custom!: boolean;
  @Column({ name: 'created_by', type: 'int', unsigned: true, nullable: true }) createdBy!: number | null;
  @Column({ name: 'created_at', ...dt, default: () => 'CURRENT_TIMESTAMP' }) createdAt!: Date;
  @Column({ name: 'updated_by', type: 'int', unsigned: true, nullable: true }) updatedBy!: number | null;
  @Column({ name: 'updated_at', ...dt, default: () => 'CURRENT_TIMESTAMP' }) updatedAt!: Date;
}

export const ALL_ENTITIES = [
  SessionDevice,
  SessionBindCode,
  SessionShop,
  SessionOpenRequest,
  SessionAuditLog,
  SessionRemoteDevice,
  SessionRemoteSession,
  SessionRemoteSignal,
  TaskRoutine,
  FlowDefinition,
  FlowRun,
  FlowStep,
  WorkItem,
  TaskDelayRequest,
  FlowCc,
  FlowEvent,
  Notification,
  FinanceDocument,
  FinanceDocumentLine,
  FinanceDocumentAccount,
  FinanceDocumentSettlement,
  FinanceCostSnapshot,
  FinanceApiKey,
  FinanceMasterSnapshot,
  OutboxJob,
  ResourceImportBackup,
  FeeArchiveSnapshot,
  OutboxSwitch,
  FinanceEntry,
  FinanceDocumentEvent,
  Company,
  PlatformAdmin,
  CompanyApplication,
  Department,
  Position,
  PositionDuty,
  PositionPermission,
  User,
  UserPermissionOverride,
  EmployeeCompensationRecord,
  AuditLog,
  ResourceRecord,
  ResourceLink,
  ResourceChangeLog,
  IntegrationSetting,
  ResourceFile,
  FormDraft,
  PhoneUploadSession,
  ProductVerificationEvent,
  AfterSalesCase,
  OrderAppeal,
  CaseLog,
  SupervisionException,
  SupervisionRuleRow,
  FlowTemplateRow,
  FlowNodeTemplate,  ResourceCategoryOption,
];
