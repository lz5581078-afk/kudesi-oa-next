import { FeishuIdentity1756000000000 } from './migrations/1756000000000-FeishuIdentity';
import { SkuSnapshotPrecision1757000000000 } from './migrations/1757000000000-SkuSnapshotPrecision';
import { SessionMaintenanceParity1758000000000 } from './migrations/1758000000000-SessionMaintenanceParity';
import 'reflect-metadata';
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ALL_ENTITIES } from '../entities';
import { BundleSyncExtras1740000000000 } from './migrations/1740000000000-BundleSyncExtras';
import { FlowCustomTemplates1746000000000 } from './migrations/1746000000000-FlowCustomTemplates';
import { FlowTimeouts1746000001000 } from './migrations/1746000001000-FlowTimeouts';
import { TaskSupervision1745000000000 } from './migrations/1745000000000-TaskSupervision';
import { AiProviders1745000001000 } from './migrations/1745000001000-AiProviders';
import { PlatformIntegrationApps1745000002000 } from './migrations/1745000002000-PlatformIntegrationApps';
import { FeeSnapshots1741000000000 } from './migrations/1741000000000-FeeSnapshots';
import { ResourceLinkKind1751000000000 } from './migrations/1751000000000-ResourceLinkKind';
import { ResourceCategoryOptions1752000000000 } from './migrations/1752000000000-ResourceCategoryOptions';
import { DocDiscount1753000000000 } from './migrations/1753000000000-DocDiscount';
import { DocPayAccountsTransferFee1754000000000 } from './migrations/1754000000000-DocPayAccountsTransferFee';
import { FlowGaps1755000000000 } from './migrations/1755000000000-FlowGaps';
import { DocLineItemNameUnit1743000000000 } from './migrations/1743000000000-DocLineItemNameUnit';
import { AfterSalesSupervision1748000000000 } from './migrations/1748000000000-AfterSalesSupervision';
import { ResourceLinkProps1735000000001 } from './migrations/1735000000001-ResourceLinkProps';
import { FormDrafts1739000000000 } from './migrations/1739000000000-FormDrafts';
import { ProductVerificationEvents1739000002000 } from './migrations/1739000002000-ProductVerificationEvents';
import { TaskReviewStages1747000000000 } from './migrations/1747000000000-TaskReviewStages';
import { PhoneUploadSessions1739000001000 } from './migrations/1739000001000-PhoneUploadSessions';
import { ResourceArchive1735000000000 } from './migrations/1735000000000-ResourceArchive';
import { OrgPeopleFields1738000000000 } from './migrations/1738000000000-OrgPeopleFields';
import { UnitPricePrecision1734000000000 } from './migrations/1734000000000-UnitPricePrecision';
import { LegacySourceHash1733000000000 } from './migrations/1733000000000-LegacySourceHash';
import { LegacyImport1732000000000 } from './migrations/1732000000000-LegacyImport';
import { InitialSchema1730000000000 } from './migrations/1730000000000-InitialSchema';
import { FinanceDocuments1730000300000 } from './migrations/1730000300000-FinanceDocuments';
import { StoreWithdrawal1730000600000 } from './migrations/1730000600000-StoreWithdrawal';
import { WithdrawalVoucher1730000700000 } from './migrations/1730000700000-WithdrawalVoucher';
import { AgentReleases1730007000000 } from './migrations/1730007000000-AgentReleases';
import { PlatformAdmin1731000000000 } from './migrations/1731000000000-PlatformAdmin';
import { Outbox1730001300000 } from './migrations/1730001300000-Outbox';
import { ImportBackups1730001400000 } from './migrations/1730001400000-ImportBackups';
import { ManualLinks1730001500000 } from './migrations/1730001500000-ManualLinks';
import { OrgProfile1730001600000 } from './migrations/1730001600000-OrgProfile';
import { ExtraPositions1730001700000 } from './migrations/1730001700000-ExtraPositions';
import { FinanceKeyAccountsAndDeviceUpdates1730003000000 } from './migrations/1730003000000-FinanceKeyAccountsAndDeviceUpdates';
import { CostSnapshotMargin61730004000000 } from './migrations/1730004000000-CostSnapshotMargin6';
import { RemoteAssist1730006000000 } from './migrations/1730006000000-RemoteAssist';
import { DataTools1730001200000 } from './migrations/1730001200000-DataTools';
import { DocumentSettlements1730001100000 } from './migrations/1730001100000-DocumentSettlements';
import { TransferAccountsAndLineObjects1730001000000 } from './migrations/1730001000000-TransferAccountsAndLineObjects';
import { FinanceAudit1730000900000 } from './migrations/1730000900000-FinanceAudit';
import { FinanceSettlement1730000800000 } from './migrations/1730000800000-FinanceSettlement';
import { TaskCenter1730000500000 } from './migrations/1730000500000-TaskCenter';
import { FlowEngine1730000400000 } from './migrations/1730000400000-FlowEngine';
import { IntegrationsAndFiles1730000200000 } from './migrations/1730000200000-IntegrationsAndFiles';
import { LiveManagement1749000000000 } from './migrations/1749000000000-LiveManagement';
import { ResourceTables1730000100000 } from './migrations/1730000100000-ResourceTables';

// 仓库根目录的 .env（从 apps/api/src/database 向上四级）
loadDotenv({ path: path.resolve(__dirname, '../../../../.env') });

export const MIGRATIONS = [InitialSchema1730000000000, ResourceTables1730000100000, IntegrationsAndFiles1730000200000, FinanceDocuments1730000300000, FlowEngine1730000400000, TaskCenter1730000500000, StoreWithdrawal1730000600000, WithdrawalVoucher1730000700000, FinanceSettlement1730000800000, FinanceAudit1730000900000, TransferAccountsAndLineObjects1730001000000, DocumentSettlements1730001100000, DataTools1730001200000, Outbox1730001300000, ImportBackups1730001400000, ManualLinks1730001500000, OrgProfile1730001600000, ExtraPositions1730001700000, FinanceKeyAccountsAndDeviceUpdates1730003000000, CostSnapshotMargin61730004000000, RemoteAssist1730006000000, AgentReleases1730007000000, PlatformAdmin1731000000000, LegacyImport1732000000000, LegacySourceHash1733000000000, UnitPricePrecision1734000000000, ResourceArchive1735000000000, ResourceLinkProps1735000000001, FeeSnapshots1741000000000, OrgPeopleFields1738000000000, FormDrafts1739000000000, PhoneUploadSessions1739000001000, BundleSyncExtras1740000000000, ProductVerificationEvents1739000002000, DocLineItemNameUnit1743000000000, TaskReviewStages1747000000000, AfterSalesSupervision1748000000000, ResourceLinkKind1751000000000, FlowCustomTemplates1746000000000, FlowTimeouts1746000001000, TaskSupervision1745000000000, AiProviders1745000001000, PlatformIntegrationApps1745000002000, LiveManagement1749000000000, ResourceCategoryOptions1752000000000, DocDiscount1753000000000, DocPayAccountsTransferFee1754000000000, FlowGaps1755000000000, FeishuIdentity1756000000000, SkuSnapshotPrecision1757000000000, SessionMaintenanceParity1758000000000];

export function buildDataSourceOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`缺少必填环境变量 ${name}`);
    return value;
  };
  return {
    type: 'mysql',
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT ?? 3306),
    username: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
    charset: 'utf8mb4',
    timezone: '+08:00',
    // DATE 列按字符串 YYYY-MM-DD 读，不经过 JS 的 Date，避免进程时区不是东八区时差一天
    dateStrings: ['DATE'],
    entities: ALL_ENTITIES,
    migrations: MIGRATIONS,
    // 表结构只通过迁移修改，永远不要打开 synchronize
    synchronize: false,
    migrationsRun: false,
  };
}

/**
 * 让 MySQL 会话时区和上面的 timezone 一致。否则 `DEFAULT CURRENT_TIMESTAMP` 按数据库服务器自己的时区写入，
 * 而程序按 +08:00 读取，时间会整体偏移（换一台服务器就变）。
 */
export async function alignSessionTimeZone(ds: DataSource) {
  const pool = (ds.driver as unknown as { pool?: { on: (e: string, f: (c: { query: (sql: string) => void }) => void) => void } }).pool;
  pool?.on('connection', (c) => c.query("SET time_zone = '+08:00'"));
  await ds.query("SET time_zone = '+08:00'");
  return ds;
}

// TypeORM CLI（migration:run 等）使用
export default new DataSource(buildDataSourceOptions());
