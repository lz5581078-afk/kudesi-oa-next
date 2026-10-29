import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { FLOW_TEMPLATES, normalizeSpecs, type SkuSpec, type WarehouseSpec } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, FlowEvent, FlowRun, FlowStep, Notification, WorkItem } from '../entities';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { FlowService } from './flow.service';
import { SKU_TEMPLATE, reviewSignature, skuBatchApply } from './sku-apply';

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const REF_RE = /^(B[0-9a-z]{1,19}|run-\d{1,10})$/;
const SKU_FIELD_KEYS = FLOW_TEMPLATES.find((t) => t.key === SKU_TEMPLATE)!.fields.map((f) => f.key);

export type BatchAction = 'pass' | 'return' | 'reject' | 'cancel' | 'resubmit';
export interface BatchItemIn { runId: number; revision: number; stepId?: number }
export interface BatchResult { runId: number; ok: boolean; message?: string }

/**
 * SKU 批量申请的“申请汇总”：一张申请单（拆开办理时是同一个 batchKey 的多条流程，没拆开是一条流程）为一行，
 * 办理人按申请而不是按规格逐条点（旧系统：一张申请一行待办、批量通过/退回、仓库整单退回）。
 * 这里不改流转规则：每个规格仍是独立的流程，所有动作都走流程引擎（办理资格、版本号、适配器校验、审计、通知都和单条办理一样）。
 */
@Injectable()
export class SkuBatchService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly bundles: BundleToolsService) {}

  /** 申请单里你能看到的流程（按 batchKey 或 run-编号） */
  private async members(em: EntityManager, user: AuthUser, ref: string): Promise<FlowRun[]> {
    if (!REF_RE.test(ref)) throw new BadRequestException('申请单编号不对');
    const runs = ref.startsWith('run-')
      ? await em.find(FlowRun, { where: { id: Number(ref.slice(4)), companyId: user.companyId, templateKey: SKU_TEMPLATE } })
      : await em.createQueryBuilder(FlowRun, 'r')
        .where('r.companyId = :c AND r.templateKey = :t AND JSON_UNQUOTE(JSON_EXTRACT(r.payload, :p)) = :k', { c: user.companyId, t: SKU_TEMPLATE, p: '$._batchKey', k: ref })
        .orderBy('r.id', 'ASC').limit(200).getMany();
    const seen: FlowRun[] = [];
    for (const r of runs) if (await this.flow.canSeeRun(em, user, r)) seen.push(r);
    if (!seen.length) throw new NotFoundException('申请单不存在，或你没有查看权限');
    return seen;
  }

  // ================= 汇总看板 =================

  async board(user: AuthUser, ref: string) {
    const em = this.ds.manager;
    const runs = await this.members(em, user, ref);
    const runIds = runs.map((r) => r.id);
    const steps = await em.find(FlowStep, { where: { runId: In(runIds) }, order: { seq: 'ASC' } });
    const active = new Map<number, FlowStep>();
    const lastReturn = new Map<number, FlowStep>();
    for (const s of steps) {
      if (s.status === 'active') active.set(s.runId, s);
      if (s.action === 'return') lastReturn.set(s.runId, s);
    }
    const mine = await em.find(WorkItem, { where: { companyId: user.companyId, runId: In(runIds), assigneeId: user.id, status: 'open' }, select: ['id', 'runId', 'stepId'] });
    const myStep = new Set(mine.map((w) => w.stepId));
    const names = await this.flow.userNames(em, user.companyId, [...runs.map((r) => r.requesterId), ...steps.flatMap((s) => [...s.recipients, ...(s.handledBy ? [s.handledBy] : [])])]);
    const now = Date.now();
    const items: Array<Record<string, unknown>> = [];
    for (const run of runs) {
      const st = active.get(run.id);
      const specs: SkuSpec[] = normalizeSpecs(run.payload.specs).specs;
      const ret = st?.enteredVia === 'return' ? lastReturn.get(run.id) : undefined;
      const iHold = !!st && myStep.has(st.id);
      for (const [i, sp] of specs.entries()) {
        items.push({
          runId: run.id, specIndex: i, specName: sp.name, specCount: specs.length, runStatus: run.status, revision: run.revision,
          stepId: st?.id ?? null, stepKey: st?.stepKey ?? null, stepName: st?.stepName ?? (run.status === 'completed' ? '已完成' : run.status === 'running' ? '' : '已结束'), stepType: st?.stepType ?? null,
          enteredVia: st?.enteredVia ?? null, dueAt: st?.dueAt ?? null, overdue: !!st?.dueAt && st.dueAt.getTime() < now, recipients: (st?.recipients ?? []).map((u) => names.get(u) ?? ''),
          mine: iHold, canResubmit: run.status === 'running' && run.requesterId === user.id && st?.stepType === 'submit',
          returnReason: ret?.comment ?? null, returnedBy: ret?.handledBy ? names.get(ret.handledBy) ?? '' : null, returnedAt: ret?.finishedAt ?? null,
        });
      }
    }
    // 你名下待办最多的那个步骤：整单退回、批量办理默认针对它
    const byStep = new Map<string, number>();
    for (const r of runs) { const st = active.get(r.id); if (st && r.status === 'running' && myStep.has(st.id)) byStep.set(st.stepKey, (byStep.get(st.stepKey) ?? 0) + 1); }
    const hold = [...byStep.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    const holdKey = hold?.[0] ?? null;
    const atHold = holdKey ? runs.filter((r) => r.status === 'running' && active.get(r.id)?.stepKey === holdKey) : [];
    const canReturnAll = !!holdKey && active.get(atHold[0]?.id)?.stepType !== 'submit' && atHold.every((r) => myStep.has(active.get(r.id)!.id));
    const events = await em.find(FlowEvent, { where: { runId: In(runIds) }, order: { id: 'DESC' }, take: 200 });
    const evNames = await this.flow.userNames(em, user.companyId, events.map((e) => e.actorId));
    const first = runs[0];
    return {
      ref, batchKey: str(first.payload._batchKey) || null, batchName: str(first.payload.batchName), requesterId: first.requesterId, requesterName: names.get(first.requesterId) ?? '',
      total: items.length, runCount: runs.length,
      counts: { running: items.filter((x) => x.runStatus === 'running').length, completed: items.filter((x) => x.runStatus === 'completed').length, ended: items.filter((x) => x.runStatus === 'cancelled' || x.runStatus === 'rejected').length, returned: items.filter((x) => x.runStatus === 'running' && x.enteredVia === 'return').length, mine: items.filter((x) => x.mine).length },
      me: { isRequester: first.requesterId === user.id, holdStepKey: holdKey, holdStepName: holdKey ? active.get(atHold[0].id)?.stepName ?? '' : '', holdCount: hold?.[1] ?? 0, canReturnAll },
      items,
      history: events.map((e) => {
        const run = runs.find((r) => r.id === e.runId)!;
        const sp = normalizeSpecs(run.payload.specs).specs;
        return { id: e.id, runId: e.runId, action: e.action, note: e.note, actorName: evNames.get(e.actorId) ?? '', createdAt: e.createdAt, specNames: sp.map((x) => x.name) };
      }),
    };
  }

  // ================= 批量办理（逐条独立事务，部分成功） =================

  async act(user: AuthUser, b: { ref: string; action: BatchAction; items: BatchItemIn[]; comment?: string; form?: Record<string, unknown>; forms?: Record<string, Record<string, unknown>> }) {
    const comment = (b.comment ?? '').trim();
    if (['return', 'reject', 'cancel'].includes(b.action) && !comment) throw new BadRequestException('退回、废除、拒绝都要写原因');
    if (!b.items?.length || b.items.length > 100) throw new BadRequestException('请选择 1 到 100 个规格');
    if (new Set(b.items.map((i) => i.runId)).size !== b.items.length) throw new BadRequestException('选择的规格重复');
    const runs = await this.members(this.ds.manager, user, b.ref);
    const byId = new Map(runs.map((r) => [r.id, r]));
    const results: BatchResult[] = [];
    for (const it of b.items) {
      const run = byId.get(it.runId);
      try {
        if (!run) throw new ForbiddenException('这个规格不在这张申请单里');
        const rev = { revision: it.revision, stepId: it.stepId ?? (await this.ds.manager.findOne(FlowStep, { where: { runId: run.id, status: 'active' }, order: { seq: 'DESC' } }))?.id ?? 0 };
        if (b.action === 'pass') await this.flow.pass(user, run.id, { ...rev, form: b.forms?.[String(run.id)] ?? b.form, comment: comment || undefined }, { quiet: true });
        else if (b.action === 'return') await this.flow.returnBack(user, run.id, { ...rev, reason: comment }, { quiet: true });
        else if (b.action === 'reject' || b.action === 'cancel') await this.flow.stop(user, run.id, b.action, { ...rev, reason: comment }, { quiet: true });
        else {
          const payload = Object.fromEntries(Object.entries(run.payload).filter(([k]) => SKU_FIELD_KEYS.includes(k)));
          await this.flow.resubmit(user, run.id, { revision: it.revision, payload }, { quiet: true });
        }
        results.push({ runId: run.id, ok: true });
      } catch (e) { results.push({ runId: it.runId, ok: false, message: e instanceof Error ? e.message : '处理失败' }); }
    }
    const okIds = results.filter((r) => r.ok).map((r) => r.runId);
    if (okIds.length) await this.summarize(this.ds.manager, user, b.ref, runs, okIds, b.action, comment);
    await this.audit(user, `flow.sku.batch.${b.action}`, b.ref, { runIds: okIds, failed: results.filter((r) => !r.ok), comment: comment || null });
    return { results, ok: okIds.length, failed: results.length - okIds.length };
  }

  // ================= 整单退回 =================

  /**
   * 整单退回（旧系统“仓库整单退回运营”）：这张申请单在你这一步上的全部规格一起退回，一个事务，要么全退要么都不退。
   * 条件和旧版一致：这一步上申请单里所有在办规格都必须是你名下的待办（别人手里还有就不能整单退）；退回原因必填。
   * 退到哪一步和单条退回一样（仓库退回发起人、财务退回仓库）。
   */
  async returnAll(user: AuthUser, b: { ref: string; items: BatchItemIn[]; reason: string }) {
    const reason = (b.reason ?? '').trim();
    if (!reason) throw new BadRequestException('整单退回要写原因');
    if (!b.items?.length || b.items.length > 200) throw new BadRequestException('退回的规格数量不对');
    const out = await this.ds.transaction(async (em) => {
      this.flow.markQuiet(em);
      const runs = await this.members(em, user, b.ref);
      const locked: FlowRun[] = [];
      for (const r of [...runs].sort((x, y) => x.id - y.id)) locked.push(await em.findOneOrFail(FlowRun, { where: { id: r.id }, lock: { mode: 'pessimistic_write' } }));
      const active = new Map<number, FlowStep>();
      for (const r of locked) if (r.status === 'running') { const st = await em.findOne(FlowStep, { where: { runId: r.id, status: 'active' }, order: { seq: 'DESC' } }); if (st) active.set(r.id, st); }
      const first = b.items[0];
      const stepKey = active.get(first.runId)?.stepKey;
      if (!stepKey) throw new ConflictException('申请单已经变化，请刷新后重新退回');
      const cand = locked.filter((r) => active.get(r.id)?.stepKey === stepKey);
      if (active.get(cand[0].id)!.stepType === 'submit') throw new BadRequestException('发起步骤不能退回');
      for (const r of cand) {
        const mine = await em.findOne(WorkItem, { where: { companyId: user.companyId, stepId: active.get(r.id)!.id, assigneeId: user.id, status: 'open' } });
        if (!mine) throw new ForbiddenException('这一步申请单里还有不是你办理的规格，不能整单退回；可以只勾选你名下的规格退回');
      }
      const want = new Map(b.items.map((i) => [i.runId, i.revision]));
      if (want.size !== cand.length || cand.some((r) => want.get(r.id) !== r.revision)) throw new ConflictException('申请单里的规格或资料已经变化，请刷新后重新退回');
      for (const r of cand) await this.flow.returnBackIn(em, user, r.id, { revision: r.revision, stepId: active.get(r.id)!.id, reason });
      return { runs: locked, ids: cand.map((r) => r.id) };
    });
    await this.summarize(this.ds.manager, user, b.ref, out.runs, out.ids, 'return', reason);
    await this.audit(user, 'flow.sku.return-all', b.ref, { runIds: out.ids, reason });
    return { ok: true, count: out.ids.length };
  }

  // ================= 个别规格退回 =================

  /**
   * 个别规格退回：只退回有问题的规格，其余继续流转。
   * 拆开办理的申请，每个规格本来就是独立的流程，直接用“勾选规格后退回”；这里处理的是没有拆开的一条流程里装了多个规格的情况：
   * 把被退回的规格拆出成一条新流程（挂在同一张申请单下，带着已办理的历史），拆出的这条退回；剩下的规格留在原流程继续往下走。
   */
  async returnSpecs(user: AuthUser, b: { runId: number; revision: number; stepId: number; specs: string[]; reason: string }) {
    const reason = (b.reason ?? '').trim();
    if (!reason) throw new BadRequestException('退回要写原因');
    const want = new Set((b.specs ?? []).map((x) => x.trim()).filter(Boolean));
    if (!want.size) throw new BadRequestException('请选择要退回的规格');
    const out = await this.ds.transaction(async (em) => {
      this.flow.markQuiet(em);
      const run = await this.flow.lockRun(em, user, b.runId, b.revision);
      if (run.templateKey !== SKU_TEMPLATE) throw new BadRequestException('这不是 SKU 批量申请');
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await em.findOne(FlowStep, { where: { id: b.stepId, runId: run.id, status: 'active' } });
      if (!step) throw new ConflictException('这一步已经被处理过了，请刷新后再看');
      if (step.stepType === 'submit') throw new BadRequestException('发起步骤不能退回');
      const mine = await em.findOne(WorkItem, { where: { companyId: user.companyId, stepId: step.id, assigneeId: user.id, status: 'open' } });
      if (!mine) throw new ForbiddenException('这一步不是你办理的');
      const specs: SkuSpec[] = normalizeSpecs(run.payload.specs).specs;
      const unknown = [...want].filter((n) => !specs.some((s) => s.name === n));
      if (unknown.length) throw new BadRequestException(`申请里没有规格：${unknown.join('、')}`);
      const batchKey = str(run.payload._batchKey) || `B${Date.now().toString(36)}${randomBytes(3).toString('hex')}`.slice(0, 20);
      // 全部规格都退 = 整条流程退回（不用拆）
      if (want.size === specs.length) {
        if (!str(run.payload._batchKey)) await em.query("UPDATE flow_runs SET payload = JSON_SET(payload, '$._batchKey', ?) WHERE id = ?", [batchKey, run.id]);
        await this.flow.returnBackIn(em, user, run.id, { revision: run.revision, stepId: step.id, reason });
        return { ref: batchKey, newRunId: run.id, split: false, runs: [run.id] };
      }
      const wh = Array.isArray(run.payload._warehouse) ? (run.payload._warehouse as WarehouseSpec[]) : null;
      const pick = <T,>(arr: T[], keep: boolean) => arr.filter((_, i) => want.has(specs[i].name) === keep);
      const restPayload: Record<string, unknown> = { ...run.payload, specs: pick(specs, false), _batchKey: batchKey };
      const carvedPayload: Record<string, unknown> = { ...run.payload, specs: pick(specs, true), _batchKey: batchKey };
      delete carvedPayload._reviewSig;
      if (wh && wh.length === specs.length) { restPayload._warehouse = pick(wh, false); carvedPayload._warehouse = pick(wh, true); } else { delete restPayload._warehouse; delete carvedPayload._warehouse; delete restPayload._reviewSig; }
      // 财务已经核对过的指纹是按全部规格算的，剩下的规格要重新算，否则财务通过时会报“编码发生了变化”
      if (run.payload._reviewSig && Array.isArray(restPayload._warehouse)) restPayload._reviewSig = await reviewSignature(em, user, this.bundles, restPayload, restPayload._warehouse as WarehouseSpec[], run.id);
      run.payload = restPayload;
      run.title = await skuBatchApply.title(em, run.companyId, restPayload);
      run.revision += 1;
      await em.save(FlowRun, run);
      const ins = await em.insert(FlowRun, {
        companyId: run.companyId, definitionId: run.definitionId, templateKey: run.templateKey, title: await skuBatchApply.title(em, run.companyId, carvedPayload), status: 'running',
        requesterId: run.requesterId, currentStepKey: run.currentStepKey, payload: carvedPayload, stepsSnapshot: run.stepsSnapshot, escalateUserIds: run.escalateUserIds, dueAt: run.dueAt, requestKey: null,
      } as never);
      const newId = Number(ins.identifiers[0].id);
      let newStepId = 0;
      for (const s of await em.find(FlowStep, { where: { runId: run.id }, order: { seq: 'ASC' } })) {
        const r = await em.insert(FlowStep, { companyId: s.companyId, runId: newId, seq: s.seq, stepKey: s.stepKey, stepName: s.stepName, stepType: s.stepType, status: s.status, enteredVia: s.enteredVia, recipients: s.recipients, handledBy: s.handledBy, action: s.action, comment: s.comment, form: s.form as never, enteredAt: s.enteredAt, finishedAt: s.finishedAt, dueAt: s.dueAt });
        if (s.id === step.id) newStepId = Number(r.identifiers[0].id);
      }
      for (const w of await em.find(WorkItem, { where: { stepId: step.id, status: 'open' } })) {
        await em.insert(WorkItem, { companyId: w.companyId, kind: 'flow', runId: newId, stepId: newStepId, assigneeId: w.assigneeId, title: w.title, status: 'open', dueAt: w.dueAt, overdueNotifiedAt: w.overdueNotifiedAt });
      }
      const names = [...want].join('、');
      await this.flow.event(em, { ...run, id: newId } as FlowRun, run.requesterId, 'submit', null, `由申请 #${run.id} 拆分而来（规格被退回：${names}）`);
      await this.flow.event(em, run, user.id, 'return', step.id, `部分规格退回：${names}（已拆出为申请 #${newId} 退回）。原因：${reason}`);
      await this.flow.returnBackIn(em, user, newId, { revision: 1, stepId: newStepId, reason });
      return { ref: batchKey, newRunId: newId, split: true, runs: [run.id, newId] };
    });
    const runs = await this.members(this.ds.manager, user, out.ref).catch(() => [] as FlowRun[]);
    if (runs.length) await this.summarize(this.ds.manager, user, out.ref, runs, [out.newRunId], 'return', reason);
    await this.audit(user, 'flow.sku.return-specs', out.ref, { runId: b.runId, newRunId: out.newRunId, specs: [...want], reason, split: out.split });
    return { ok: true, ref: out.ref, newRunId: out.newRunId, split: out.split };
  }

  // ================= 汇总通知与审计 =================

  /** 批量动作不逐条发通知，办完后给相关的人各发一条汇总（站内通知；飞书入队仍是逐条的） */
  private async summarize(em: EntityManager, user: AuthUser, ref: string, runs: FlowRun[], runIds: number[], action: BatchAction, comment: string) {
    if (!runIds.length) return;
    const fresh = await em.find(FlowRun, { where: { id: In(runIds), companyId: user.companyId } });
    const name = str(runs[0]?.payload.batchName) || '申请单';
    const link = `/workbench/todos?batch=${ref}`;
    const rows: Array<{ uid: number; stepName: string; via: string; n: string }> = await em.query(
      `SELECT w.assignee_id AS uid, s.step_name AS stepName, s.entered_via AS via, COUNT(*) AS n FROM work_items w JOIN flow_steps s ON s.id = w.step_id
       WHERE w.company_id = ? AND w.status = 'open' AND w.run_id IN (${runIds.map(() => '?').join(',')}) GROUP BY w.assignee_id, s.step_name, s.entered_via`, [user.companyId, ...runIds]);
    for (const r of rows) {
      const returned = r.via === 'return';
      await em.insert(Notification, {
        companyId: user.companyId, userId: r.uid, kind: returned ? 'returned' : 'todo', title: `${returned ? '被退回' : '新待办'}：${name}（${r.n} 个规格 · ${r.stepName}）`.slice(0, 200),
        body: returned && comment ? `退回原因：${comment}`.slice(0, 500) : null, link,
      });
    }
    const ended = fresh.filter((r) => r.status !== 'running');
    for (const status of ['completed', 'cancelled', 'rejected'] as const) {
      const k = ended.filter((r) => r.status === status);
      if (!k.length) continue;
      const word = status === 'completed' ? '已完成' : status === 'cancelled' ? '已废除' : '被拒绝';
      await em.insert(Notification, { companyId: user.companyId, userId: fresh[0].requesterId, kind: 'result', title: `${name}：${k.length} 个规格${word}`.slice(0, 200), body: action === 'pass' || !comment ? null : comment.slice(0, 500), link: `/workbench/started?batch=${ref}` });
    }
  }

  private audit(user: AuthUser, action: string, ref: string, detail: Record<string, unknown>) {
    return this.ds.manager.save(AuditLog, this.ds.manager.create(AuditLog, { companyId: user.companyId, actorId: user.id, action, resourceType: 'flow_batch', resourceId: ref, detail }));
  }
}
