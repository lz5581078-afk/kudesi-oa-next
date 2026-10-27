import { LocalFilesController } from './integrations/local-files.controller';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CryptoService } from './common/crypto.service';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { PermissionsGuard } from './common/permissions.guard';
import { loadEnv } from './config/env';
import { DataSource, DataSourceOptions } from 'typeorm';
import { MIGRATIONS, alignSessionTimeZone } from './database/data-source';
import {
  ALL_ENTITIES,
  AuditLog,
  Company,
  PlatformAdmin,
  Department,
  IntegrationSetting,
  Position,
  PositionPermission,
  ResourceChangeLog,
  ResourceFile,
  ResourceLink,
  ResourceRecord,
  User,
  UserPermissionOverride,
} from './entities';
import { HealthController } from './health/health.controller';
import { FilesController, IntegrationSettingsController, OcrController } from './integrations/integrations.controller';
import { defaultStorageFactory, FilesService, STORAGE_FACTORY } from './integrations/files.service';
import { IntegrationSettingsService } from './integrations/integration-settings.service';
import { OcrService } from './integrations/ocr.service';
import { RevenueController } from './resources/revenue.controller';
import { OutboxController } from './outbox/outbox.controller';
import { OutboxService } from './outbox/outbox.service';
import { CatalogApiController, DataToolsController, ExternalFeedController } from './resources/data-tools.controller';
import { CatalogApiService } from './resources/catalog-api.service';
import { JstMaintenanceController } from './resources/jst-maintenance.controller';
import { JstMaintenanceService } from './resources/jst-maintenance.service';
import { BaseCodeToolsController } from './resources/base-code-tools.controller';
import { BaseCodeToolsService } from './resources/base-code-tools.service';
import { BundleToolsController } from './resources/bundle-tools.controller';
import { BundleToolsService } from './resources/bundle-tools.service';
import { DataToolsService } from './resources/data-tools.service';
import { FeeArchiveController } from './resources/fee-archive.controller';
import { FeeArchiveService } from './resources/fee-archive.service';
import { LaborController } from './resources/labor.controller';
import { FeeSnapshotService } from './resources/fee-snapshot.service';
import { EmployeePartyController } from './resources/employee-party.controller';
import { EmployeePartyService } from './resources/employee-party.service';
import { LaborCopyService } from './resources/labor-copy.service';
import { RevenueService } from './resources/revenue.service';
import { AgentController, MaintenanceController, SessionController } from './session/session.controller';
import { MaintenanceService } from './session/maintenance.service';
import { RemoteAssistAgentController, RemoteAssistController } from './session/remote.controller';
import { RemoteAssistService } from './session/remote.service';
import { SessionService } from './session/session.service';
import { TaskController } from './flow/task.controller';
import { TaskService } from './flow/task.service';
import { FlowController } from './flow/flow.controller';
import { FlowScheduler } from './flow/flow.scheduler';
import { FlowService } from './flow/flow.service';
import { SkuApplyController } from './flow/sku-apply.controller';
import { SkuApplyService } from './flow/sku-apply.service';
import { CostController } from './resources/cost.controller';
import { CostService } from './resources/cost.service';
import { ExpressController } from './resources/express.controller';
import { ExpressService } from './resources/express.service';
import { CostMaintainService } from './resources/cost-maintain.service';
import { PricingDebugService } from './resources/pricing-debug.service';
import { FinanceDocumentsController } from './resources/finance-documents.controller';
import { FinanceDocumentsService } from './resources/finance-documents.service';
import { ResourcesController } from './resources/resources.controller';
import { AssetsController } from './resources/assets.controller';
import { AssetsService } from './resources/assets.service';
import { DataIssuesService } from './resources/data-issues.service';
import { ResourcesService } from './resources/resources.service';
import { OrgController } from './org/org.controller';
import { OrgAdminController } from './org/org-admin.controller';
import { AuditController, BankFundController } from './org/audit.controller';
import { OrgAdminService } from './org/org-admin.service';
import { OrgService } from './org/org.service';
import { CompanyApplyController, PlatformController } from './platform/platform.controller';
import { PlatformService } from './platform/platform.service';

const env = loadEnv();

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
      type: 'mysql',
      host: env.db.host,
      port: env.db.port,
      username: env.db.user,
      password: env.db.password,
      database: env.db.name,
      charset: 'utf8mb4',
      timezone: '+08:00',
      entities: ALL_ENTITIES,
      migrations: MIGRATIONS,
      synchronize: false,
      migrationsRun: false,
      }),
      dataSourceFactory: async (options) => alignSessionTimeZone(await new DataSource(options as DataSourceOptions).initialize()),
    }),
    TypeOrmModule.forFeature([
      Company,
      PlatformAdmin,
      Department,
      Position,
      PositionPermission,
      User,
      UserPermissionOverride,
      AuditLog,
      ResourceRecord,
      ResourceLink,
      ResourceChangeLog,
      IntegrationSetting,
      ResourceFile,
    ]),
    JwtModule.register({ secret: env.jwtSecret, signOptions: { expiresIn: env.jwtExpiresIn as never } }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
  ],
  controllers: [LocalFilesController, HealthController, AuthController, CompanyApplyController, PlatformController, OrgController, OrgAdminController, AuditController, BankFundController, AssetsController, ResourcesController, IntegrationSettingsController, FilesController, OcrController, RevenueController, CostController, FeeArchiveController, LaborController, EmployeePartyController, OutboxController, DataToolsController, ExternalFeedController, ExpressController, BaseCodeToolsController, BundleToolsController, FinanceDocumentsController, FlowController, SkuApplyController, TaskController, SessionController, MaintenanceController, AgentController, RemoteAssistController, RemoteAssistAgentController],
  providers: [
    AuthService,
    PlatformService,
    OrgService,
    OrgAdminService,
    ResourcesService,
    AssetsService,
    DataIssuesService,
    RevenueService,
    FeeArchiveService,
    LaborCopyService,
    EmployeePartyService,
    FeeSnapshotService,
    DataToolsService,
    BaseCodeToolsService,
    CatalogApiService,
    JstMaintenanceService,
    BundleToolsService,
    OutboxService,
    CostService,
    ExpressService,
    CostMaintainService,
    PricingDebugService,
    FlowService,
    SkuApplyService,
    TaskService,
    SessionService,
    MaintenanceService,
    RemoteAssistService,
    FlowScheduler,
    FinanceDocumentsService,
    IntegrationSettingsService,
    FilesService,
    OcrService,
    { provide: STORAGE_FACTORY, useValue: defaultStorageFactory },
    { provide: CryptoService, useValue: new CryptoService(env.encryptionKeys, env.encryptionActiveKeyId) },
    // 守卫顺序：限流 → 登录 → 权限（默认拒绝）
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
