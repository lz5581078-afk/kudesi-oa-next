import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  GRID_SAVE_MAX_ROWS,
  createChecker,
  getResourceDef,
  gridFieldAccess,
  gridPolicyOf,
  permissionOwner,
  resourcePermission,
  type GridFailCode,
  type GridRowResult,
  type GridSaveRequest,
  type GridSaveResponse,
  type ResourceDef,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceDto, ResourcesService } from './resources.service';

const NOTE = '表格编辑';

function failure(e: unknown): { code: GridFailCode; message: string } {
  if (e instanceof ConflictException) {
    const message = e.message;
    return { code: /刚被别人修改/.test(message) ? 'conflict' : 'invalid', message };
  }
  if (e instanceof NotFoundException) return { code: 'not_found', message: e.message };
  if (e instanceof ForbiddenException) return { code: 'forbidden', message: e.message };
  if (e instanceof BadRequestException) {
    const r = e.getResponse() as { message?: string | string[] } | string;
    const m = typeof r === 'string' ? r : r.message;
    return { code: 'invalid', message: Array.isArray(m) ? m.join('；') : (m ?? e.message) };
  }
  return { code: 'error', message: e instanceof Error ? e.message : '保存失败' };
}

/**
 * 表格编辑的批量保存：逐行独立事务，成功的落库，失败的返回原因。
 * 每一行都交给 ResourcesService 的同一套保存流程（字段校验、唯一性、特殊规则、引用、日志），这里不直写表；
 * 公司和操作人只取自令牌。网格额外收紧：只能改网格允许的字段（见 gridFieldAccess）。
 */
@Injectable()
export class GridSaveService {
  constructor(private readonly resources: ResourcesService) {}

  async save(user: AuthUser, type: string, body: GridSaveRequest): Promise<GridSaveResponse<ResourceDto>> {
    const def = getResourceDef(type);
    if (!def) throw new NotFoundException('没有这种资料');
    const policy = gridPolicyOf(type);
    if (!policy.enabled) throw new BadRequestException(policy.reason ?? '这类资料不支持表格编辑');
    const updates = body.updates ?? [];
    const creates = body.creates ?? [];
    const archives = body.archives ?? [];
    if (updates.length + creates.length + archives.length > GRID_SAVE_MAX_ROWS) throw new BadRequestException(`一次最多保存 ${GRID_SAVE_MAX_ROWS} 行`);
    if (updates.length + creates.length + archives.length === 0) throw new BadRequestException('没有要保存的修改');

    const can = createChecker(user.permissions);
    const owner = permissionOwner(type);
    const canCreate = can(resourcePermission(owner, 'create'));
    const canArchive = can(resourcePermission(owner, 'delete'));
    const canSecret = can(resourcePermission(owner, 'secret'));
    const results: GridRowResult<ResourceDto>[] = [];

    const run = async (r: GridRowResult<ResourceDto>, fn: () => Promise<number>) => {
      try {
        r.id = await fn();
        r.ok = true;
      } catch (e) {
        Object.assign(r, { ok: false, ...failure(e) });
      }
      results.push(r);
    };

    for (const row of updates) {
      const r: GridRowResult<ResourceDto> = { kind: 'update', id: row.id, ok: false };
      const bad = this.checkFields(def, row.data, can, canSecret);
      if (bad) { results.push({ ...r, code: 'forbidden', message: bad }); continue; }
      if (row.status !== undefined && !can(resourcePermission(owner, 'disable'))) { results.push({ ...r, code: 'forbidden', message: '没有改状态（停用/启用）的权限' }); continue; }
      await run(r, () => this.resources.saveGridRow(user, type, { id: row.id, version: row.version, values: row.data, status: row.status, statusReason: row.statusReason }, NOTE));
    }
    for (const row of creates) {
      const r: GridRowResult<ResourceDto> = { kind: 'create', clientId: row.clientId, ok: false };
      if (!policy.canCreate) { results.push({ ...r, code: 'forbidden', message: policy.reason ?? '这类资料不能在表格里新增' }); continue; }
      if (!canCreate) { results.push({ ...r, code: 'forbidden', message: '没有新增权限' }); continue; }
      const bad = this.checkFields(def, row.data, can, canSecret);
      if (bad) { results.push({ ...r, code: 'forbidden', message: bad }); continue; }
      const clean = Object.fromEntries(Object.entries(row.data).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      await run(r, () => this.resources.saveGridRow(user, type, { values: clean }, NOTE));
    }
    for (const row of archives) {
      const r: GridRowResult<ResourceDto> = { kind: 'archive', id: row.id, ok: false };
      if (!policy.canArchive) { results.push({ ...r, code: 'forbidden', message: '这类资料不支持归档' }); continue; }
      if (!canArchive) { results.push({ ...r, code: 'forbidden', message: '没有删除（归档）权限' }); continue; }
      await run(r, async () => {
        if (row.version && row.version !== (await this.resources.gridVersionOf(user, type, row.id))) throw new ConflictException('这条资料刚被别人修改过，请刷新后再处理');
        await this.resources.archive(user, type, row.id, row.reason);
        return row.id;
      });
    }

    // 成功的行带回最新记录，前端直接替换显示
    const okIds = results.filter((r) => r.ok && r.kind !== 'archive' && r.id !== undefined).map((r) => r.id!);
    const fresh = new Map((await this.resources.gridRows(user, type, okIds)).map((x) => [x.id, x]));
    for (const r of results) if (r.ok && r.id !== undefined && fresh.has(r.id)) r.row = fresh.get(r.id);
    const failed = results.filter((r) => !r.ok).length;
    return { results, saved: results.length - failed, failed };
  }

  /** 网格只允许改配置里存在、且网格可编辑的字段；多余字段整行拒绝（不悄悄丢弃） */
  private checkFields(def: ResourceDef, data: Record<string, unknown>, can: (p: string) => boolean, canSecret: boolean): string | null {
    for (const key of Object.keys(data)) {
      const f = def.fields.find((x) => x.key === key);
      if (!f) return `不能修改字段「${key}」`;
      const access = gridFieldAccess(f, can, canSecret);
      if (!access.editable) return `${f.label}不能在表格里修改：${access.reason}`;
    }
    return null;
  }
}
