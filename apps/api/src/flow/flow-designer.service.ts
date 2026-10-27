import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  ASSIGNEE_NO_TARGET, BUILTIN_NODE_TEMPLATES, CUSTOM_FIELD_TYPES, FLOW_TEMPLATES, NODE_TEMPLATE_CATEGORIES, createChecker, validateCustomTemplate, validateNodeTemplate, validateSteps,
  type CustomSchema, type FieldDef, type FlowTemplate, type NodeTemplate, type StepDef,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, Department, FlowDefinition, FlowNodeTemplate, FlowTemplateRow } from '../entities';
import { customFrom, loadTemplate } from './flow-templates';
import { FlowService } from './flow.service';

const MANAGE = 'flow.templates.manage';

/** 流程目录与自建模板的生命周期：新建、复制、改名、停用/启用版本、删除；以及节点模板（节点中心）。步骤和表单结构的保存/发布仍在 FlowService。 */
@Injectable()
export class FlowDesignerService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService) {}

  private need(user: AuthUser, msg = '没有配置流程的权限') {
    if (!createChecker(user.permissions)(MANAGE)) throw new ForbiddenException(msg);
  }
  private audit(em: EntityManager, user: AuthUser, action: string, key: string, detail: Record<string, unknown>) {
    return em.save(AuditLog, em.create(AuditLog, { companyId: user.companyId, actorId: user.id, action, resourceType: 'flow_template', resourceId: key, detail }));
  }
  private async row(em: EntityManager, user: AuthUser, key: string) {
    const r = await em.findOne(FlowTemplateRow, { where: { companyId: user.companyId, templateKey: key } });
    if (!r) throw new NotFoundException('流程不存在，或内置流程不支持这个操作');
    return r;
  }
  private async checkDepartment(em: EntityManager, companyId: number, id: number | null | undefined) {
    if (id == null) return null;
    const d = await em.findOne(Department, { where: { id, companyId } });
    if (!d) throw new BadRequestException('所属部门不存在');
    return d.id;
  }

  // ================= 目录 =================

  async directory(user: AuthUser) {
    const em = this.ds.manager;
    const defs = await em.find(FlowDefinition, { where: { companyId: user.companyId } });
    const rows = await em.find(FlowTemplateRow, { where: { companyId: user.companyId }, order: { id: 'ASC' } });
    const counts: Array<{ k: string; n: string }> = await em.query('SELECT template_key AS k, COUNT(*) AS n FROM flow_runs WHERE company_id = ? GROUP BY template_key', [user.companyId]);
    const running: Array<{ k: string; n: string }> = await em.query("SELECT template_key AS k, COUNT(*) AS n FROM flow_runs WHERE company_id = ? AND status = 'running' GROUP BY template_key", [user.companyId]);
    const depts = await em.find(Department, { where: { companyId: user.companyId } });
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const make = async (t: FlowTemplate, row: FlowTemplateRow | null) => {
      const mine = defs.filter((d) => d.templateKey === t.key);
      const active = mine.find((d) => d.status === 'active');
      const draft = mine.find((d) => d.status === 'draft');
      const shown = active ?? draft ?? mine.sort((a, b) => b.version - a.version)[0];
      const steps = ((shown?.steps ?? t.steps) as StepDef[]);
      const full = row ? customFrom(row, shown ?? null) : t;
      const issues = await this.issues(user, full, shown ? steps : null, shown?.escalateUserIds ?? []);
      return {
        key: t.key, label: t.label, description: t.description, custom: !!row,
        departmentId: row?.departmentId ?? null, departmentName: row?.departmentId ? deptName.get(row.departmentId) ?? '' : '',
        status: active ? 'active' : 'inactive', version: active?.version ?? null, hasDraft: !!draft, everPublished: mine.some((d) => d.status !== 'draft'),
        stepCount: steps.filter((s) => s.type !== 'submit' && s.type !== 'end').length, issues,
        runCount: Number(counts.find((c) => c.k === t.key)?.n ?? 0), runningCount: Number(running.find((c) => c.k === t.key)?.n ?? 0),
        kind: row ? '自建流程' : '内置业务流程', updatedAt: (row?.updatedAt ?? shown?.createdAt ?? null),
      };
    };
    const list = [];
    for (const t of FLOW_TEMPLATES) list.push(await make(t, null));
    for (const r of rows) list.push(await make(customFrom(r, null), r));
    return { templates: list, canManage: createChecker(user.permissions)(MANAGE) };
  }

  /** 配置检查：缺办理人、办理人解析不到、没有可办理步骤等 */
  private async issues(user: AuthUser, t: FlowTemplate, steps: StepDef[] | null, escalate: number[]): Promise<string[]> {
    if (!steps) return t.custom ? ['还没有配置步骤'] : ['还没有配置办理人'];
    const out: string[] = [];
    const errors = t.custom ? validateCustomTemplate(t, steps, escalate) : validateSteps(t, steps, escalate);
    out.push(...errors.slice(0, 3));
    if (errors.length === 0) {
      for (const s of steps.filter((x) => x.type !== 'submit' && x.type !== 'end' && !ASSIGNEE_NO_TARGET.includes(x.assignee?.source ?? 'employee'))) {
        try { await this.flow.resolveRecipients(this.ds.manager, user.companyId, s, user.id); } catch (e) { out.push((e as Error).message); }
      }
      if (t.custom && steps.every((s) => s.type === 'submit' || s.type === 'end')) out.push('没有可办理的步骤');
    }
    return out.slice(0, 5);
  }

  // ================= 新建、复制、改名 =================

  private genKey() { return `c${crypto.randomBytes(5).toString('hex')}`; }

  /** 新建自建模板；sourceKey 给了就复制那个模板（内置模板复制得到的是不带业务适配器的自建模板，只复制步骤和表单） */
  async create(user: AuthUser, b: { name: string; description?: string; departmentId?: number | null; sourceKey?: string | null }) {
    this.need(user);
    const name = b.name?.trim();
    if (!name || name.length > 100) throw new BadRequestException('流程名称必填，最多 100 字');
    if ((b.description ?? '').length > 500) throw new BadRequestException('说明最多 500 字');
    return this.ds.transaction(async (em) => {
      const departmentId = await this.checkDepartment(em, user.companyId, b.departmentId);
      const dup = await em.findOne(FlowTemplateRow, { where: { companyId: user.companyId, name } });
      if (dup) throw new ConflictException(`已经有叫“${name}”的流程，请换个名字`);
      let steps: StepDef[] = [
        { key: 'apply', name: '提交申请', type: 'submit', assignee: { source: 'requester' } },
        { key: 'approve', name: '审批', type: 'approval', dueMinutes: 1440 },
        { key: 'end', name: '结束', type: 'end' },
      ];
      let schema: CustomSchema = { fields: [{ key: 'reason', label: '事由', type: 'textarea', group: '申请', required: true, maxLength: 500 }], stepFields: {}, posting: null };
      let escalate: number[] = [];
      let description = b.description ?? '';
      if (b.sourceKey) {
        const src = await loadTemplate(em, user.companyId, b.sourceKey);
        const srcDefs = await em.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: src.key }, order: { version: 'DESC' } });
        const srcDef = srcDefs.find((d) => d.status === 'draft') ?? srcDefs.find((d) => d.status === 'active') ?? srcDefs[0];
        steps = ((srcDef?.steps ?? src.steps) as StepDef[]).map((s) => ({ ...s, locked: undefined }));
        const ok = (f: FieldDef) => (CUSTOM_FIELD_TYPES as readonly string[]).includes(f.type);
        schema = { fields: src.fields.filter(ok), stepFields: Object.fromEntries(Object.entries(src.stepFields).map(([k, v]) => [k, v.filter(ok)])), posting: src.posting ?? null };
        escalate = srcDef?.escalateUserIds ?? [];
        if (!description) description = src.description;
        // 条件/记账声明引用了被丢掉的字段时，一并去掉，保证复制出来的是合法草稿
        const probe = { ...src, custom: true, fields: schema.fields, stepFields: schema.stepFields, posting: schema.posting ?? undefined };
        if (schema.posting && validateCustomTemplate(probe, steps, escalate).some((e) => e.includes('记账'))) schema.posting = null;
        const keep = new Set(schema.fields.map((f) => f.key));
        steps = steps.map((s) => ({ ...s, hiddenFields: s.hiddenFields?.filter((k) => keep.has(k)), when: s.when && /^payload\./.test(s.when.field) && !keep.has(s.when.field.slice(8)) ? null : s.when }));
      }
      const key = this.genKey();
      await em.insert(FlowTemplateRow, { companyId: user.companyId, templateKey: key, name, description: description.slice(0, 500) || null, departmentId, sourceKey: b.sourceKey ?? null, createdBy: user.id });
      await em.insert(FlowDefinition, { companyId: user.companyId, templateKey: key, version: 1, status: 'draft', steps, escalateUserIds: escalate, schemaJson: schema, createdBy: user.id } as never);
      await this.audit(em, user, 'flow.template.create', key, { name, sourceKey: b.sourceKey ?? null });
      return { key };
    });
  }

  async updateMeta(user: AuthUser, key: string, b: { name?: string; description?: string; departmentId?: number | null }) {
    this.need(user);
    return this.ds.transaction(async (em) => {
      const r = await this.row(em, user, key);
      if (b.name !== undefined) {
        const name = b.name.trim();
        if (!name || name.length > 100) throw new BadRequestException('流程名称必填，最多 100 字');
        const dup = await em.findOne(FlowTemplateRow, { where: { companyId: user.companyId, name } });
        if (dup && dup.id !== r.id) throw new ConflictException(`已经有叫“${name}”的流程，请换个名字`);
        r.name = name;
      }
      if (b.description !== undefined) { if (b.description.length > 500) throw new BadRequestException('说明最多 500 字'); r.description = b.description || null; }
      if (b.departmentId !== undefined) r.departmentId = await this.checkDepartment(em, user.companyId, b.departmentId);
      await em.save(FlowTemplateRow, r);
      await this.audit(em, user, 'flow.template.update', key, { name: r.name, departmentId: r.departmentId });
      return { ok: true };
    });
  }

  // ================= 启用、停用、版本 =================

  /** 停用：把当前启用版本退役，不能再发起新申请；在办的流程不受影响，历史保留 */
  async deactivate(user: AuthUser, key: string) {
    this.need(user);
    return this.ds.transaction(async (em) => {
      await loadTemplate(em, user.companyId, key);
      const rows = await em.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: key, status: 'active' }, lock: { mode: 'pessimistic_write' } });
      if (!rows.length) throw new BadRequestException('这条流程没有在启用，不需要停用');
      for (const r of rows) { r.status = 'retired'; await em.save(FlowDefinition, r); }
      await this.audit(em, user, 'flow.template.deactivate', key, { version: rows[0].version });
      return { ok: true };
    });
  }

  /** 启用某个历史版本（回退或重新启用）：先按发布规则检查，通过后它变成启用版本，原启用版本退役 */
  async activate(user: AuthUser, key: string, version: number) {
    this.need(user);
    return this.ds.transaction(async (em) => {
      const rows = await em.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: key }, order: { version: 'DESC' }, lock: { mode: 'pessimistic_write' } });
      const target = rows.find((r) => r.version === version);
      if (!target || target.status === 'draft') throw new BadRequestException('只能启用发布过的版本');
      if (target.status === 'active') throw new BadRequestException('这个版本已经在启用');
      const base = await loadTemplate(em, user.companyId, key, target.id);
      const t = base.custom ? customFrom((await this.row(em, user, key)), target) : base;
      const steps = target.steps as StepDef[];
      const errors = t.custom ? validateCustomTemplate(t, steps, target.escalateUserIds) : validateSteps(t, steps, target.escalateUserIds);
      if (errors.length) throw new BadRequestException(errors.join('；'));
      for (const s of steps.filter((x) => x.type !== 'submit' && x.type !== 'end' && !ASSIGNEE_NO_TARGET.includes(x.assignee?.source ?? 'employee'))) await this.flow.resolveRecipients(em, user.companyId, s, user.id);
      for (const r of rows.filter((x) => x.status === 'active')) { r.status = 'retired'; await em.save(FlowDefinition, r); }
      target.status = 'active';
      target.publishedAt = new Date();
      await em.save(FlowDefinition, target);
      await this.audit(em, user, 'flow.template.activate', key, { version });
      return { ok: true };
    });
  }

  /** 放弃草稿（没有草稿时什么都不做） */
  async discardDraft(user: AuthUser, key: string) {
    this.need(user);
    await this.ds.transaction(async (em) => {
      await loadTemplate(em, user.companyId, key);
      const rows = await em.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: key, status: 'draft' } });
      if (rows.length && (await em.count(FlowDefinition, { where: { companyId: user.companyId, templateKey: key } })) === 1 && await em.findOne(FlowTemplateRow, { where: { companyId: user.companyId, templateKey: key } })) throw new BadRequestException('这是新建流程的第一个草稿，不能放弃；不要了请直接删除流程');
      for (const r of rows) await em.delete(FlowDefinition, { id: r.id });
    });
    return { ok: true };
  }

  // ================= 删除 =================

  /** 只有自建模板、从未发起过任何申请才能删除；否则请用停用（保留历史） */
  async remove(user: AuthUser, key: string) {
    this.need(user);
    return this.ds.transaction(async (em) => {
      const r = await this.row(em, user, key);
      const used = await em.query('SELECT id FROM flow_runs WHERE company_id = ? AND template_key = ? LIMIT 1', [user.companyId, key]);
      if (used.length) throw new BadRequestException('该流程已有申请或历史记录，不能删除，请使用停用');
      await em.query('DELETE FROM flow_timeout_policies WHERE company_id = ? AND template_key = ?', [user.companyId, key]);
      await em.delete(FlowDefinition, { companyId: user.companyId, templateKey: key });
      await em.delete(FlowTemplateRow, { id: r.id });
      await this.audit(em, user, 'flow.template.delete', key, { name: r.name });
      return { ok: true };
    });
  }

  // ================= 节点中心 =================

  private nodeDto(r: FlowNodeTemplate): NodeTemplate & { revision: number } {
    return { key: r.nodeKey, name: r.name, description: r.description ?? '', category: r.category, type: r.stepType as NodeTemplate['type'], dueMinutes: r.dueMinutes, fields: r.fields as FieldDef[], builtin: false, revision: r.revision };
  }

  /** 内置节点模板 + 本公司节点模板；业务流程里的固定节点（借用交接、付款…）也列出来，只读 */
  async nodeTemplates(user: AuthUser) {
    const rows = await this.ds.manager.find(FlowNodeTemplate, { where: { companyId: user.companyId }, order: { id: 'ASC' } });
    const business = FLOW_TEMPLATES.flatMap((t) => t.steps.filter((s) => s.type !== 'submit' && s.type !== 'end').map((s) => ({
      key: `${t.key}:${s.key}`, name: s.name, flowLabel: t.label, type: s.type, dueMinutes: s.dueMinutes ?? null, fields: t.stepFields[s.key] ?? [],
    })));
    return {
      templates: [...BUILTIN_NODE_TEMPLATES.map((t) => ({ ...t, revision: 0 })), ...rows.map((r) => this.nodeDto(r))],
      business, categories: NODE_TEMPLATE_CATEGORIES, canManage: createChecker(user.permissions)(MANAGE),
    };
  }

  /** 保存节点模板：sourceKey 是它基于的模板；key 给了就是修改自己公司的模板（带版本号防覆盖），没给就是复制新建 */
  async saveNodeTemplate(user: AuthUser, b: { key?: string | null; sourceKey?: string | null; revision?: number; name: string; description?: string; category: string; type: string; dueMinutes?: number | null; fields: FieldDef[] }) {
    this.need(user);
    const input = { name: b.name?.trim() ?? '', description: b.description ?? '', category: b.category, type: b.type as NodeTemplate['type'], dueMinutes: b.dueMinutes ?? null, fields: b.fields ?? [] };
    const errors = validateNodeTemplate(input);
    if (errors.length) throw new BadRequestException(errors.join('；'));
    return this.ds.transaction(async (em) => {
      if (b.key) {
        const r = await em.findOne(FlowNodeTemplate, { where: { companyId: user.companyId, nodeKey: b.key }, lock: { mode: 'pessimistic_write' } });
        if (!r) throw new NotFoundException('节点模板不存在，内置模板请先复制再改');
        if (b.revision !== r.revision) throw new ConflictException('这个模板已被别人修改，请刷新后再改');
        Object.assign(r, { name: input.name, description: input.description || null, category: input.category, stepType: input.type, dueMinutes: input.dueMinutes, fields: input.fields, revision: r.revision + 1 });
        await em.save(FlowNodeTemplate, r);
        await this.audit(em, user, 'flow.node-template.update', r.nodeKey, { name: r.name, revision: r.revision });
        return { key: r.nodeKey, revision: r.revision };
      }
      const dup = await em.findOne(FlowNodeTemplate, { where: { companyId: user.companyId, name: input.name } });
      if (dup || BUILTIN_NODE_TEMPLATES.some((t) => t.name === input.name)) throw new ConflictException(`已经有叫“${input.name}”的节点模板，请换个名字`);
      const key = `n${crypto.randomBytes(5).toString('hex')}`;
      await em.insert(FlowNodeTemplate, { companyId: user.companyId, nodeKey: key, name: input.name, description: input.description || null, category: input.category, stepType: input.type, dueMinutes: input.dueMinutes, fields: input.fields, sourceKey: b.sourceKey ?? null, createdBy: user.id } as never);
      await this.audit(em, user, 'flow.node-template.create', key, { name: input.name, sourceKey: b.sourceKey ?? null });
      return { key, revision: 1 };
    });
  }

  async deleteNodeTemplate(user: AuthUser, key: string) {
    this.need(user);
    return this.ds.transaction(async (em) => {
      const r = await em.findOne(FlowNodeTemplate, { where: { companyId: user.companyId, nodeKey: key } });
      if (!r) throw new NotFoundException('节点模板不存在，内置模板不能删除');
      await em.delete(FlowNodeTemplate, { id: r.id });
      await this.audit(em, user, 'flow.node-template.delete', key, { name: r.name });
      return { ok: true };
    });
  }
}
