import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  ASSET_ACTIONS,
  ASSET_ACTIONS_BY_STATE,
  ASSET_LOG_LABELS,
  AssetAction,
  AssetState,
  getResourceDef,
  InventoryResult,
  permissionOwner,
  resourcePermission,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceLink, ResourceRecord, User } from '../entities';
import { ASSET_ACTION_FLAG } from './asset-rules';
import { ResourcesService } from './resources.service';

const KNOWN: readonly string[] = ['idle', 'in_use', 'repairing', 'retired', 'lost'];

export interface TransitionInput {
  action: AssetAction;
  userId?: number | null;
  locationId?: number | null;
  departmentId?: number | null;
  reason?: string;
  note?: string;
}

export interface InventoryItem {
  id: number;
  result: InventoryResult;
  locationId?: number | null;
}

/** 固定资产的流转（领用/转交/归还/送修/修好/丢失/找回/报废）、盘点、流转记录和位置的“存放内容”。 */
@Injectable()
export class AssetsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly resources: ResourcesService) {}

  private async loadAsset(em: EntityManager, user: AuthUser, id: number) {
    const rec = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type: 'fixed-assets' } });
    if (!rec) throw new NotFoundException('资产不存在');
    return rec;
  }

  /** 办理一次流转：状态机校验 → 必填项 → 按统一保存流程改使用人/位置/状态，并在流转记录里留一条。 */
  async transition(user: AuthUser, id: number, input: TransitionInput) {
    const rule = ASSET_ACTIONS[input.action];
    if (!rule) throw new BadRequestException('不支持的资产操作');
    await this.dataSource.transaction(async (em) => {
      em.queryRunner!.data[ASSET_ACTION_FLAG] = input.action;
      const asset = await this.loadAsset(em, user, id);
      if (asset.archivedAt) throw new ConflictException('该资产已归档，请先恢复再操作');
      // 历史数据里不认识的状态，按闲置处理
      const state = (KNOWN.includes(asset.status) ? asset.status : 'idle') as AssetState;
      if (!rule.from.includes(state)) throw new ConflictException(`当前状态不能${rule.label}，请刷新后再试`);
      const reason = (input.reason ?? '').trim();
      if (rule.needsReason && !reason) throw new BadRequestException(`${rule.label}必须填写原因`);
      if (rule.needsUser && !input.userId) throw new BadRequestException(`${rule.label}必须选择使用人`);
      if (input.action === 'transfer' && input.userId === asset.data.userId) throw new BadRequestException('请选择另一位使用人');
      const values: Record<string, unknown> = {};
      let userName = '';
      if (rule.needsUser) {
        values.userId = input.userId;
        userName = (await em.findOne(User, { where: { id: input.userId!, companyId: user.companyId } }))?.name ?? '';
      }
      if (rule.clearsUser) values.userId = null;
      if (input.locationId) values.locationId = input.locationId;
      if (input.departmentId) values.departmentId = input.departmentId;
      const next = rule.to ?? (asset.data.userId ? 'in_use' : 'idle');
      const note = [rule.label, userName && `使用人：${userName}`, reason && `原因：${reason}`, (input.note ?? '').trim()].filter(Boolean).join('；');
      await this.resources.saveChecked(em, user, 'fixed-assets', id, values, {
        status: next, note, logAction: input.action, statusReason: rule.needsReason ? reason : null,
      });
    });
    return this.resources.get(user, 'fixed-assets', id);
  }

  /** 盘点：在位只留记录；位置变动更正位置；未找到标记丢失。已报废的跳过。 */
  async inventory(user: AuthUser, items: InventoryItem[], note: string) {
    if (!items.length) throw new BadRequestException('请至少盘点一项资产');
    const summary = { present: 0, moved: 0, missing: 0, skipped: [] as number[] };
    const suffix = note.trim() ? `；${note.trim()}` : '';
    await this.dataSource.transaction(async (em) => {
      const seen = new Set<number>();
      for (const item of items) {
        if (seen.has(item.id)) { summary.skipped.push(item.id); continue; }
        seen.add(item.id);
        const asset = await em.findOne(ResourceRecord, { where: { id: item.id, companyId: user.companyId, type: 'fixed-assets' } });
        if (!asset || asset.status === 'retired' || asset.archivedAt) { summary.skipped.push(item.id); continue; }
        if (item.result === 'present') {
          await this.resources.logAction(em, user, 'fixed-assets', asset.id, 'inventory_checked', `盘点在位${suffix}`);
          summary.present++;
        } else if (item.result === 'moved') {
          if (!item.locationId) { summary.skipped.push(item.id); continue; }
          em.queryRunner!.data[ASSET_ACTION_FLAG] = 'inventory_moved';
          await this.resources.saveChecked(em, user, 'fixed-assets', asset.id, { locationId: item.locationId }, { note: `盘点发现位置变动，已更正${suffix}`, logAction: 'inventory_moved' });
          summary.moved++;
        } else if (item.result === 'missing') {
          if (asset.status !== 'lost') {
            em.queryRunner!.data[ASSET_ACTION_FLAG] = 'inventory_missing';
            await this.resources.saveChecked(em, user, 'fixed-assets', asset.id, {}, { status: 'lost', note: `盘点未找到，标记丢失${suffix}`, logAction: 'inventory_missing', statusReason: '盘点未找到' });
          } else {
            await this.resources.logAction(em, user, 'fixed-assets', asset.id, 'inventory_missing', `盘点仍未找到${suffix}`);
          }
          summary.missing++;
        } else {
          summary.skipped.push(item.id);
        }
        delete em.queryRunner!.data[ASSET_ACTION_FLAG];
      }
    });
    return { ok: true, ...summary };
  }

  /** 资产卷宗：流转记录、储物空间（以这项资产为空间的位置）和空间里存放的档案。 */
  async details(user: AuthUser, id: number) {
    const em = this.dataSource.manager;
    await this.loadAsset(em, user, id);
    const logs = (await this.resources.logs(user, 'fixed-assets', id))
      .filter((l) => l.action !== 'reveal')
      .map((l) => ({ id: l.id, action: l.action, label: ASSET_LOG_LABELS[l.action] ?? null, actor: l.actor, note: l.note, createdAt: l.createdAt }));
    const spaces = await this.resources.findWhere(em, user.companyId, 'locations', 'fixedAssetId', id);
    const spaceIds = spaces.map((s) => s.id);
    const archives = spaceIds.length
      ? (await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'archives' } })).filter((a) => spaceIds.includes(Number(a.data.locationId)))
      : [];
    return {
      state: ASSET_ACTIONS_BY_STATE,
      operationLogs: logs,
      storageSpaces: spaces.map((s) => ({ id: s.id, title: s.title, parentId: Number(s.data.parentId) || null, status: s.status, locationType: s.data.locationType ?? null })),
      archiveItems: archives.map((a) => ({ id: a.id, title: a.title, archiveNo: a.data.archiveNo ?? null, status: a.status, locationId: Number(a.data.locationId) })),
    };
  }

  /** 位置的“存放内容”：哪些资料把它当作位置（子位置、档案、固定资产、U盾、证照的各个位置槽位、手机号、开户档案、宽带…）。 */
  async locationContents(user: AuthUser, id: number, can: (permission: string) => boolean) {
    const em = this.dataSource.manager;
    const loc = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type: 'locations' } });
    if (!loc) throw new NotFoundException('位置不存在');
    const links = await em.find(ResourceLink, { where: { companyId: user.companyId, targetType: 'locations', targetId: id } });
    const incoming = links.filter((l) => l.relation !== 'manual');
    const records = incoming.length ? await em.find(ResourceRecord, { where: { companyId: user.companyId, id: In([...new Set(incoming.map((l) => l.sourceId))]) } }) : [];
    const byId = new Map(records.map((r) => [r.id, r]));
    const groups = new Map<string, { type: string; typeLabel: string; items: Array<{ id: number; title: string; status: string; statusLabel: string; slots: string[] }> }>();
    for (const l of incoming) {
      const r = byId.get(l.sourceId);
      if (!r || r.type !== l.sourceType) continue;
      if (!can(resourcePermission(permissionOwner(r.type), 'view'))) continue;
      const def = getResourceDef(r.type);
      if (!def) continue;
      let g = groups.get(r.type);
      if (!g) groups.set(r.type, (g = { type: r.type, typeLabel: def.label, items: [] }));
      let item = g.items.find((x) => x.id === r.id);
      if (!item) g.items.push((item = { id: r.id, title: r.title, status: r.status, statusLabel: def.statuses.find((s) => s.value === r.status)?.label ?? r.status, slots: [] }));
      // 证照里同一个位置可能是正本位置、公章位置等多个槽位；位置本身（locationId）不用特别说明
      const label = def.fields.find((f) => f.key === l.relation)?.label;
      if (label && !item.slots.includes(label)) item.slots.push(label);
    }
    const order = ['locations', 'archives', 'fixed-assets'];
    return [...groups.values()].sort((a, b) => (order.indexOf(a.type) + 1 || 99) - (order.indexOf(b.type) + 1 || 99));
  }
}
