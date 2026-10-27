import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { getFlowTemplate, type CustomSchema, type FlowTemplate, type StepDef } from '@kudesi/shared';
import { FlowDefinition, FlowTemplateRow } from '../entities';
import type { FlowAdapter } from './flow-adapters';
import { FLOW_ADAPTERS } from './flow-adapters';

/**
 * 解析流程模板：内置模板来自 shared 代码；公司自建模板由“目录属性（flow_templates）+ 某个版本（flow_definitions）”拼出。
 * 指定 definitionId 时取那个版本（在办流程用启动时的版本，所以修改模板不影响在途流程）；否则取当前启用版本，没有就取最新版本。
 */
export async function loadTemplate(em: EntityManager, companyId: number, key: string, definitionId?: number | null): Promise<FlowTemplate> {
  const builtin = getFlowTemplate(key);
  if (builtin) return builtin;
  const row = await em.findOne(FlowTemplateRow, { where: { companyId, templateKey: key } });
  if (!row) throw new NotFoundException('没有这种流程');
  let def: FlowDefinition | null = null;
  if (definitionId) def = await em.findOne(FlowDefinition, { where: { id: definitionId, companyId, templateKey: key } });
  if (!def) def = await em.findOne(FlowDefinition, { where: { companyId, templateKey: key, status: 'active' } });
  if (!def) def = (await em.find(FlowDefinition, { where: { companyId, templateKey: key }, order: { version: 'DESC' }, take: 1 }))[0] ?? null;
  return customFrom(row, def);
}

/** 用某个版本（可能是草稿）拼出自建模板；def 为空时给空表单 */
export function customFrom(row: FlowTemplateRow, def: FlowDefinition | null, steps?: StepDef[]): FlowTemplate {
  const schema = (def?.schemaJson ?? {}) as Partial<CustomSchema>;
  return {
    key: row.templateKey, label: row.name, description: row.description ?? '', custom: true,
    fields: schema.fields ?? [], stepFields: schema.stepFields ?? {}, steps: steps ?? ((def?.steps ?? []) as StepDef[]),
    ...(schema.posting ? { posting: schema.posting } : {}),
  };
}

/** 没有专门业务适配器的流程（所有自建模板）用的通用适配器：只有标题，没有业务副作用 */
export function adapterFor(t: FlowTemplate): FlowAdapter {
  const builtin = FLOW_ADAPTERS[t.key];
  if (builtin) return builtin;
  return {
    key: t.key,
    async title(_em, _companyId, payload) {
      const first = t.fields.find((f) => (f.type === 'text' || f.type === 'textarea') && typeof payload[f.key] === 'string' && payload[f.key]);
      return `${t.label}${first ? ` · ${String(payload[first.key]).slice(0, 60)}` : ''}`.slice(0, 200);
    },
  };
}
