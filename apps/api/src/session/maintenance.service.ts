import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { FilesService } from '../integrations/files.service';
import { ResourcesService } from '../resources/resources.service';
import { ResourceRecord, SessionShop } from '../entities';
import { SessionService } from './session.service';

export const MAINTENANCE_WORKSPACE = 'company_store_maintenance';
const STATUS_LABELS: Record<string, string> = { normal: '正常', abnormal: '异常', cancelled: '注销', inactive: '停用' };

/**
 * 公司店铺维护：和店铺提现共用同一套“授权电脑 + 店铺登录”能力，但是单独一份店铺清单和权限；
 * 额外可以直接改店铺档案的状态（异常必须从异常原因库里选一条）。
 */
@Injectable()
export class MaintenanceService extends SessionService {
  protected readonly ws: string = MAINTENANCE_WORKSPACE;
  protected readonly manageKey: string = 'resource.company-store-maintenance.manage';
  protected readonly manageDenied: string = '没有公司店铺维护的管理权限';
  protected readonly addableStatuses: string[] = ['normal', 'abnormal', 'cancelled', 'inactive'];

  constructor(@InjectDataSource() dataSource: DataSource, crypto: CryptoService, files: FilesService, private readonly resources: ResourcesService) {
    super(dataSource, crypto, files);
  }

  async abnormalReasons(user: AuthUser) {
    const rows = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'store-abnormal-reasons', status: 'normal' }, order: { id: 'DESC' } });
    return rows.map((r) => ({ id: r.id, reason: r.title }));
  }

  /** 改店铺档案状态：店铺必须在本清单里；异常要选原因库里的一条；注销/停用要写原因。 */
  async setStoreStatus(user: AuthUser, shopId: number, p: { status: string; abnormalReasonId?: number; reason?: string }) {
    this.needManage(user);
    if (!STATUS_LABELS[p.status]) throw new BadRequestException('店铺状态无效');
    const shop = await this.dataSource.manager.findOne(SessionShop, { where: { id: shopId, companyId: user.companyId, workspace: this.ws, status: 'active' } });
    if (!shop) throw new NotFoundException('店铺不在公司店铺维护清单里');
    if (p.status === 'abnormal') {
      if (!p.abnormalReasonId) throw new BadRequestException('店铺状态选择异常时，必须选择异常原因');
      const r = await this.dataSource.manager.findOne(ResourceRecord, { where: { id: p.abnormalReasonId, companyId: user.companyId, type: 'store-abnormal-reasons', status: 'normal' } });
      if (!r) throw new BadRequestException('请选择店铺档案中已有的异常原因');
    }
    await this.resources.changeStatus(user, 'stores', shop.storeId, p.status, p.reason);
    if (p.status === 'abnormal') await this.resources.update(user, 'stores', shop.storeId, { abnormalReason: p.abnormalReasonId });
    await this.dataSource.transaction(async (em) => this.log(em, user.companyId, 'store_status_changed', `店铺档案状态改为「${STATUS_LABELS[p.status]}」`, { actorId: user.id, storeId: shop.storeId }));
    return { ok: true, status: p.status, statusLabel: STATUS_LABELS[p.status] };
  }
}
