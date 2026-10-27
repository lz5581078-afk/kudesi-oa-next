import { Injectable } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { createChecker, resourcePermission } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceLink, ResourceRecord } from '../entities';

const ROW_LIMIT = 50;
const INACTIVE = ['inactive', 'cancelled'];

export interface DataIssueRow { id: number; type: string; name: string; detail: string }
export interface DataIssueGroup { key: string; label: string; description: string; resourceType: string; count: number; rows: DataIssueRow[] }

const filled = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
const has = (data: Record<string, unknown>, ...keys: string[]) => keys.some((k) => filled(data[k]));

/**
 * 数据问题检查（旧系统“资料总览 → 数据问题”）：只读，按公司隔离，跳过已归档和停用的资料。
 * 旧系统里“关联表和资料字段不一致”的几类（关联冲突、数据对齐）在新系统里不会出现：关联只由资料字段派生，
 * 没有第二份副本，所以这里只保留“资料之间缺少该有的关联”的检查。每类只在调用人有对应资料查看权限时才返回。
 */
@Injectable()
export class DataIssuesService {
  constructor(private readonly ds: DataSource) {}

  private async load(companyId: number, type: string) {
    const rows = await this.ds.manager.find(ResourceRecord, { where: { companyId, type, archivedAt: IsNull() } });
    return rows.filter((r) => !INACTIVE.includes(r.status));
  }

  async check(user: AuthUser) {
    const can = createChecker(user.permissions);
    const canView = (type: string) => can(resourcePermission(type, 'view'));
    const groups: DataIssueGroup[] = [];
    const add = (key: string, label: string, description: string, resourceType: string, rows: DataIssueRow[]) => {
      groups.push({ key, label, description, resourceType, count: rows.length, rows: rows.slice(0, ROW_LIMIT) });
    };
    const row = (r: ResourceRecord, detail: string): DataIssueRow => ({ id: r.id, type: r.type, name: r.title ?? `#${r.id}`, detail });

    if (canView('stores')) {
      const stores = await this.load(user.companyId, 'stores');
      add('stores_without_license', '店铺没有绑定营业执照', '这些店铺还没有填写所属营业执照，开票、对账和资质会找不到主体。', 'stores',
        stores.filter((s) => !has(s.data, 'licenseId')).map((s) => row(s, s.data.storeNo ? `店铺编号 ${s.data.storeNo}` : '')));
      add('stores_phone_text_unlinked', '店铺手机号没有关联手机号档案', '店铺里填了绑定手机号，但没有选择对应的手机号档案。', 'stores',
        stores.filter((s) => has(s.data, 'phoneNumber') && !has(s.data, 'phoneId')).map((s) => row(s, `绑定手机号 ${s.data.phoneNumber}：未关联档案`)));
    }

    if (canView('phones')) {
      const phones = await this.load(user.companyId, 'phones');
      const incoming = phones.length
        ? await this.ds.manager.find(ResourceLink, { where: { companyId: user.companyId, targetType: 'phones', targetId: In(phones.map((p) => p.id)) } })
        : [];
      const linked = new Set(incoming.map((l) => l.targetId));
      add('phones_without_binding', '手机号没有任何绑定', '没有被店铺、银行账户等引用，也没有使用人、保管人、合作人或固定资产。确认是否闲置或漏登记。', 'phones',
        phones.filter((p) => !linked.has(p.id) && !has(p.data, 'userId', 'externalUser', 'keeperUserId', 'keeperName', 'partnerId', 'assetId', 'parentPhoneId'))
          .map((p) => row(p, String(p.data.carrier ?? ''))));
    }

    if (canView('bank-accounts')) {
      const banks = await this.load(user.companyId, 'bank-accounts');
      const kindLabel: Record<string, string> = { company_public: '公司公户', company_card: '公司银行卡', store_public: '店铺公户', store_personal_card: '店铺个人银行卡' };
      add('bank_accounts_without_owner', '银行账户没有归属', '公司账户没有绑定营业执照，或店铺账户没有绑定店铺。出纳账户不检查。', 'bank-accounts',
        banks.filter((b) => {
          const kind = String(b.data.kind ?? '');
          if (kind === 'company_public' || kind === 'company_card') return !has(b.data, 'licenseId');
          if (kind === 'store_public' || kind === 'store_personal_card') return !has(b.data, 'storeId');
          return false;
        }).map((b) => row(b, `${kindLabel[String(b.data.kind)] ?? ''}，未绑定${String(b.data.kind).startsWith('store') ? '店铺' : '营业执照'}`)));
      add('bank_phone_text_unlinked', '银行预留手机没有关联手机号档案', '银行账户填了预留手机号码，但没有选择对应的手机号档案。', 'bank-accounts',
        banks.filter((b) => has(b.data, 'reservedPhoneNumber') && !has(b.data, 'phoneId')).map((b) => row(b, `预留手机 ${b.data.reservedPhoneNumber}：未关联档案`)));

      if (canView('licenses')) {
        const licenses = await this.load(user.companyId, 'licenses');
        const ownedPublic = new Set(banks.filter((b) => b.data.kind === 'company_public' && has(b.data, 'licenseId')).map((b) => Number(b.data.licenseId)));
        const ownedCard = new Set(banks.filter((b) => b.data.kind === 'company_card' && has(b.data, 'licenseId')).map((b) => Number(b.data.licenseId)));
        add('license_bank_unlinked', '执照登记的公户/法人银行卡未建银行账户', '营业执照上登记了对公账户或法人账户，但银行账户里没有归属这张执照的对应账户。', 'licenses',
          licenses.flatMap((l) => [
            ...(has(l.data, 'publicAccountName') && !ownedPublic.has(l.id) ? [row(l, '执照登记的公户还没有对应的银行账户')] : []),
            ...(has(l.data, 'legalCardName') && !ownedCard.has(l.id) ? [row(l, '执照登记的法人银行卡还没有对应的银行账户')] : []),
          ]));
      }
    }

    if (canView('licenses')) {
      const licenses = await this.load(user.companyId, 'licenses');
      add('licenses_missing_photos', '营业执照缺少照片', '没有上传正本或副本照片。', 'licenses',
        licenses.filter((l) => !has(l.data, 'originalPhoto') || !has(l.data, 'copyPhoto'))
          .map((l) => row(l, [!has(l.data, 'originalPhoto') ? '缺正本照片' : '', !has(l.data, 'copyPhoto') ? '缺副本照片' : ''].filter(Boolean).join('、'))));
    }

    // 固定资产的位置/使用人不存在、档案关联的资料已删除，在新系统里由引用校验保证，这里不再重复检查。
    return { total: groups.reduce((n, g) => n + g.count, 0), groups };
  }
}
