import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import {
  OUTBOUND_LABELS, baseCodeOutbound, buildSnapshot, diffSnapshots, groupIssues, parseSnapshot, sigOf, stripCostChanges, stripOutboundCost,
} from './base-code-support';
import { ResourcesService } from './resources.service';

const TYPE = 'finance-base-codes';
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export interface VerifyItem { id: number; signature: string; uploadSignature?: string }
export interface DeleteGroupInput { token: string; ids: number[] }

/** 基础编码的核对、批量验证、删除。每一步都走统一的资料服务，成本类字段按权限在服务端去掉。 */
@Injectable()
export class BaseCodeToolsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly resources: ResourcesService,
    private readonly outbox: OutboxService,
  ) {}

  private canCost(user: AuthUser) { return createChecker(user.permissions)('product.cost.view'); }

  private async load(em: EntityManager, user: AuthUser, id: number) {
    const bc = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type: TYPE } });
    if (!bc) throw new NotFoundException('基础编码不存在');
    return bc;
  }

  /** 三个状态页签的数量，以及每个分类下各状态的数量（页面左侧分类目录用） */
  async overview(user: AuthUser) {
    const rows = await this.ds.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: TYPE }, select: ['id', 'status', 'data'] });
    const status: Record<string, number> = {};
    const byCategory: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      status[r.status] = (status[r.status] ?? 0) + 1;
      const c = String(r.data.categoryId ?? 0);
      byCategory[c] ??= {};
      byCategory[c][r.status] = (byCategory[c][r.status] ?? 0) + 1;
    }
    return { status, byCategory };
  }

  /** 核对报告：资料问题（按档案和引用路径分组）、二次验证的前后差异、将要上传的内容 */
  async report(user: AuthUser, id: number) {
    const em = this.ds.manager;
    const bc = await this.load(em, user, id);
    const cost = this.canCost(user);
    const { snapshot, issues, signature } = await buildSnapshot(em, user.companyId, bc);
    const stored = parseSnapshot(bc.data.snapshot);
    const changes = stored ? diffSnapshots(stored, snapshot) : [];
    const out = await baseCodeOutbound(em, user.companyId, bc);
    const uploaded = str(bc.data.jstUploadedCode);
    const real = typeof bc.data.canonicalId === 'number' ? await em.findOne(ResourceRecord, { where: { id: bc.data.canonicalId, companyId: user.companyId, type: TYPE } }) : null;
    return {
      id: bc.id,
      code: str(bc.data.code),
      name: str(bc.data.name) || bc.title,
      status: bc.status,
      aliasOf: real ? { id: real.id, code: str(real.data.code) } : null,
      signature,
      issues: groupIssues(issues),
      issueCount: issues.length,
      secondVerification: bc.status === 'reverify',
      baselineMissing: bc.status === 'reverify' && !stored,
      changes: cost ? changes : stripCostChanges(changes),
      outbound: { labels: OUTBOUND_LABELS, values: cost ? out : stripOutboundCost(out) },
      uploadSignature: sigOf(JSON.stringify(out)),
      uploadedCode: uploaded || null,
      replacing: !!uploaded && uploaded !== str(bc.data.code),
      jstStatus: str(bc.data.jstStatus) || 'not_synced',
    };
  }

  /**
   * 批量验证：每条都要带着核对时看到的快照指纹，资料在核对后又变了就拒绝；
   * 要同步聚水潭的，还要带上传内容指纹（核对时看到的 = 实际上传的），并且只入队，不直接发送。
   */
  async verify(user: AuthUser, items: VerifyItem[], opts: { confirmed: boolean; syncToJst: boolean; replaceConfirmed?: boolean }) {
    if (!opts.confirmed) throw new BadRequestException('请先勾选“已核对”');
    if (!items.length) throw new BadRequestException('没有要验证的基础编码');
    if (items.length > 200) throw new BadRequestException('一次最多验证 200 条');
    if (opts.syncToJst && !user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能把验证结果同步到聚水潭');
    const results: { id: number; ok: boolean; error?: string; queued?: boolean }[] = [];
    for (const it of items) {
      try {
        const em = this.ds.manager;
        const bc = await this.load(em, user, it.id);
        if (!['pending', 'reverify'].includes(bc.status)) throw new BadRequestException('这条已经验证过了');
        const rep = await buildSnapshot(em, user.companyId, bc);
        if (rep.signature !== it.signature) throw new ConflictException('核对之后资料又变了，请重新核对');
        if (rep.issues.length) throw new BadRequestException(`还有 ${rep.issues.length} 个资料问题没有处理`);
        if (opts.syncToJst) {
          const up = sigOf(JSON.stringify(await baseCodeOutbound(em, user.companyId, bc)));
          if (!it.uploadSignature || it.uploadSignature !== up) throw new ConflictException('要上传的内容在核对之后变了，请重新核对');
        }
        await this.resources.changeStatus(user, TYPE, it.id, 'verified');
        let queued = false;
        if (opts.syncToJst) queued = (await this.outbox.enqueue(user, TYPE, [it.id], { replaceConfirmed: opts.replaceConfirmed })).queued > 0;
        results.push({ id: it.id, ok: true, queued });
      } catch (e) {
        results.push({ id: it.id, ok: false, error: (e as Error).message });
      }
    }
    return { results, verified: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }

  // ---------- 删除 ----------

  private async groupsFor(em: EntityManager, user: AuthUser, mode: 'pending' | 'source', ids?: number[]) {
    const all = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: TYPE } });
    const byId = new Map(all.map((r) => [r.id, r]));
    const lines = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-bundle-lines' }, select: ['id', 'data'] });
    const used = new Set(lines.map((l) => Number(l.data.baseCodeId)));
    const products = new Map((await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-products' }, select: ['id', 'status'] })).map((p) => [p.id, p.status]));
    const realOf = (r: ResourceRecord) => (typeof r.data.canonicalId === 'number' ? byId.get(r.data.canonicalId) ?? r : r);
    const roots = new Map<number, ResourceRecord>();
    const source = ids?.length ? ids.map((i) => byId.get(i)).filter((r): r is ResourceRecord => !!r) : all;
    if (ids?.length && source.length < ids.length) throw new BadRequestException('有基础编码不存在');
    for (const r of source) {
      const root = realOf(r);
      if (mode === 'source' && !ids?.length && (products.get(Number(root.data.productId)) !== 'deleted' || root.status === 'deleted')) continue;
      if (mode === 'pending' && !ids?.length) continue;
      roots.set(root.id, root);
    }
    return [...roots.values()].map((root) => {
      const members = [root, ...all.filter((a) => a.data.canonicalId === root.id)];
      let reason = '';
      if (mode === 'pending') {
        const touched = members.find((m) => m.data.verifiedAt || m.data.snapshot || m.data.jstUploadedCode || ['synced', 'pending', 'failed'].includes(str(m.data.jstStatus)) || m.status === 'verified' || m.status === 'reverify');
        if (touched) reason = `「${touched.title}」验证过或同步过聚水潭，不能直接删除`;
      } else {
        if (products.get(Number(root.data.productId)) !== 'deleted') reason = '来源商品档案还在，不能按“来源已删除”处理';
        else if (root.status === 'deleted') reason = '已经处理过了';
      }
      const referenced = members.find((m) => used.has(m.id));
      if (!reason && referenced) reason = `「${referenced.title}」还被组合引用，请先处理这些组合`;
      return {
        token: sigOf(mode, ...members.map((m) => `${m.id}:${m.updatedAt ? new Date(m.updatedAt).getTime() : 0}`)),
        ids: members.map((m) => m.id),
        code: str(root.data.code),
        name: str(root.data.name) || root.title,
        aliasCount: members.length - 1,
        everSynced: members.some((m) => !!m.data.jstUploadedCode),
        canDelete: !reason,
        reason,
      };
    });
  }

  async deletionPreview(user: AuthUser, mode: 'pending' | 'source', ids?: number[]) {
    return { mode, groups: await this.groupsFor(this.ds.manager, user, mode, ids) };
  }

  async deletionExecute(user: AuthUser, mode: 'pending' | 'source', groups: DeleteGroupInput[], reason: string, disableConfirmed: boolean) {
    if (reason.trim().length < 2) throw new BadRequestException('必须写明删除原因');
    if (!groups.length) throw new BadRequestException('没有要处理的基础编码');
    const fresh = await this.groupsFor(this.ds.manager, user, mode, groups.flatMap((g) => g.ids));
    const results: { code: string; ok: boolean; error?: string; disableQueued?: boolean }[] = [];
    for (const g of groups) {
      const cur = fresh.find((f) => f.token === g.token);
      if (!cur) { results.push({ code: '', ok: false, error: '资料在预览之后变了，请重新预览' }); continue; }
      try {
        if (!cur.canDelete) throw new BadRequestException(cur.reason);
        if (mode === 'pending') {
          for (const id of [...cur.ids].reverse()) await this.resources.remove(user, TYPE, id, reason.trim());
          results.push({ code: cur.code, ok: true });
        } else {
          if (cur.everSynced && !disableConfirmed) throw new BadRequestException('这个编码上传过聚水潭，需要确认“同时在聚水潭停用它”');
          let queued = false;
          for (const id of cur.ids) {
            if (cur.everSynced) queued = (await this.outbox.enqueueDisable(user, TYPE, id, reason.trim())).queued || queued;
            await this.resources.changeStatus(user, TYPE, id, 'deleted', reason.trim());
          }
          results.push({ code: cur.code, ok: true, disableQueued: queued });
        }
      } catch (e) {
        results.push({ code: cur.code, ok: false, error: (e as Error).message });
      }
    }
    return { results };
  }

  /** 停用任务的进度（走出站队列，失败可以在“同步队列”里重试） */
  async deletionJobs(user: AuthUser) {
    const rows = await this.ds.query(
      "SELECT id, kind, resource_id AS resourceId, status, attempts, last_error AS lastError, created_at AS createdAt, done_at AS doneAt, payload_json AS payload FROM outbox_jobs WHERE company_id = ? AND resource_type = ? AND kind = 'base_code_disable' ORDER BY id DESC LIMIT 100",
      [user.companyId, TYPE]);
    return { rows };
  }
}
