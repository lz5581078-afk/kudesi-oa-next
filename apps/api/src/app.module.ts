import { PhoneUploadController } from './integrations/phone-upload.controller';
import { PhoneUploadService } from './integrations/phone-upload.service';
import { FormDraftsController } from './resources/form-drafts.controller';
import { FormDraftsService } from './resources/form-drafts.service';
import { AfterSalesService } from './service/after-sales.service';
import { AppealsService } from './service/appeals.service';
import { CaseSupport } from './service/case-support';
import { AfterSalesController, AppealsController, SupervisionController } from './service/service.controller';
import { ServiceWorkspaceProvider } from './service/service-workspace.provider';
import { SupervisionScheduler } from './service/supervision.scheduler';
import { SupervisionService } from './service/supervision.service';
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
import { AiProviderService } from './integrations/ai-providers.service';
import { AiSettingsController, FilesController, IntegrationSettingsController, OcrController } from './integrations/integrations.controller';
import { defaultStorageFactory, FilesService, STORAGE_FACTORY } from './integrations/files.service';
import { IntegrationSettingsService } from './integrations/integration-settings.service';
import { OcrService } from './integrations/ocr.service';
import { RevenueController } from './resources/revenue.controller';
import { OutboxController } from './outbox/outbox.controller';
import { OutboxService } from './outbox/outbox.service';
import { FeishuNoticeController } from './outbox/feishu-notice.controller';
import { FeishuNoticeService } from './outbox/feishu-notice.service';
import { CategoryToolsController, ProductCodePreviewController } from './resources/category-tools.controller';
import { CategoryToolsService } from './resources/category-tools.service';
import { PriceSyncService } from './outbox/price-sync.service';
import { CategorySyncService } from './outbox/category-sync.service';
import { CatalogApiController, DataToolsController, ExternalFeedController, LegacyVerifiedFeedController } from './resources/data-tools.controller';
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
import { PackagingImportController } from './resources/packaging-import.controller';
import { PackagingImportService } from './resources/packaging-import.service';
import { ProductCostExcelController } from './resources/product-cost-excel.controller';
import { ProductCostExcelService } from './resources/product-cost-excel.service';
import { FeeSnapshotService } from './resources/fee-snapshot.service';
import { EmployeePartyController } from './resources/employee-party.controller';
import { WorkforceController } from './workforce/workforce.controller';
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
import { LiveController } from './live/live.controller';
import { LiveLedgerService } from './live/live-ledger.service';
import { LiveOrderSource, UnconfiguredLiveOrderSource } from './live/live-order-source';
import { LiveScheduleService } from './live/live-schedule.service';
import { LiveScheduler } from './live/live.scheduler';
import { LiveWorkspaceModule } from './live/live-workspace';
import { LiveSessionService } from './live/live-session.service';
import { LiveSettlementService } from './live/live-settlement.service';
import { FlowService } from './flow/flow.service';
import { FlowDesignerController } from './flow/flow-designer.controller';
import { FlowDesignerService } from './flow/flow-designer.service';
import { FlowTimeoutService } from './flow/flow-timeout.service';
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
import { ResourceCategoriesController } from './resources/resource-categories.controller';
import { ResourceCategoriesService } from './resources/resource-categories.service';
import { AssetsController } from './resources/assets.controller';
import { AssetsService } from './resources/assets.service';
import { FeeLedgerController } from './resources/fee-ledger.controller';
import { FeeLedgerService } from './resources/fee-ledger.service';
import { DataIssuesService } from './resources/data-issues.service';
import { GridSaveService } from './resources/grid-save.service';
import { ResourcesService } from './resources/resources.service';
import { OrgController } from './org/org.controller';
import { OrgAdminController } from './org/org-admin.controller';
import { AuditController, BankFundController } from './org/audit.controller';
import { OrgAdminService } from './org/org-admin.service';
import { StaffImportService } from './org/staff-import.service';
import { OrgService } from './org/org.service';
import { CompanyApplyController, PlatformController, PlatformIntegrationController } from './platform/platform.controller';
import { PlatformIntegrationService } from './platform/platform-integrations.service';
import { PlatformService } from './platform/platform.service';

import { WorkspaceController } from './workspace/workspace.controller';
import { WorkspaceService } from './workspace/workspace.service';
import { WorkspaceModuleRegistry } from './workspace/module-registry';

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
<<<<<<< HEAD
  controllers: [LocalFilesController, HealthController, AuthController, CompanyApplyController, PlatformController, PlatformIntegrationController, OrgController, OrgAdminController, AuditController, BankFundController, AssetsController, FeeLedgerController, ResourcesController, IntegrationSettingsController, AiSettingsController, FilesController, OcrController, RevenueController, CostController, FeeArchiveController, LaborController, PackagingImportController, EmployeePartyController, OutboxController, FeishuNoticeController, CategoryToolsController, ProductCodePreviewController, DataToolsController, ExternalFeedController, LegacyVerifiedFeedController, ExpressController, BaseCodeToolsController, BundleToolsController, FinanceDocumentsController, FlowController, FlowDesignerController, SkuApplyController, TaskController, SessionController, MaintenanceController, AgentController, RemoteAssistController, RemoteAssistAgentController, FormDraftsController, PhoneUploadController, ProductCostExcelController, WorkspaceController, AfterSalesController, AppealsController, SupervisionController, LiveController, WorkforceController],
=======
  controllers: [LocalFilesController, HealthController, AuthController, CompanyApplyController, PlatformController, PlatformIntegrationController, OrgController, OrgAdminController, AuditController, BankFundController, AssetsController, ResourceCategoriesController, ResourcesController, IntegrationSettingsController, AiSettingsController, FilesController, OcrController, RevenueController, CostController, FeeArchiveController, LaborController, PackagingImportController, EmployeePartyController, OutboxController, FeishuNoticeController, CategoryToolsController, ProductCodePreviewController, DataToolsController, ExternalFeedController, LegacyVerifiedFeedController, ExpressController, BaseCodeToolsController, BundleToolsController, FinanceDocumentsController, FlowController, FlowDesignerController, SkuApplyController, TaskController, SessionController, MaintenanceController, AgentController, RemoteAssistController, RemoteAssistAgentController, FormDraftsController, PhoneUploadController, ProductCostExcelController, WorkspaceController, AfterSalesController, AppealsController, SupervisionController, LiveController, WorkforceController],
>>>>>>> 7a6dcb8 (资料页签“管理分类”：公司级分类配置表、管理接口、齿轮与管理弹窗，分类在校验/导入导出/列筛选/表格编辑/表单中生效)
  providers: [
    AuthService,
    PlatformService,
    PlatformIntegrationService,
    OrgService,
    OrgAdminService,
    StaffImportService,
    ResourcesService,
    GridSaveService,
    ResourceCategoriesService,
    AssetsService,
    FeeLedgerService,
    DataIssuesService,
    RevenueService,
    FeeArchiveService,
    LaborCopyService,
    PackagingImportService,
    ProductCostExcelService,
    EmployeePartyService,
    FeeSnapshotService,
    DataToolsService,
    BaseCodeToolsService,
    CatalogApiService,
    JstMaintenanceService,
    BundleToolsService,
    OutboxService,
    FeishuNoticeService,
    CategoryToolsService,
    PriceSyncService,
    CategorySyncService,
    CostService,
    ExpressService,
    CostMaintainService,
    PricingDebugService,
    FlowService,
    FlowDesignerService,
    FlowTimeoutService,
    SkuApplyService,
    TaskService,
    FormDraftsService,
    PhoneUploadService,
    SessionService,
    MaintenanceService,
    RemoteAssistService,
    FlowScheduler,
    WorkspaceService,
    WorkspaceModuleRegistry,
    CaseSupport,
    AfterSalesService,
    AppealsService,
    SupervisionService,
    SupervisionScheduler,
    ServiceWorkspaceProvider,
    LiveScheduleService, LiveSessionService, LiveLedgerService, LiveSettlementService, LiveScheduler, LiveWorkspaceModule,
    { provide: LiveOrderSource, useClass: UnconfiguredLiveOrderSource },
    FinanceDocumentsService,
    IntegrationSettingsService,
    AiProviderService,
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
