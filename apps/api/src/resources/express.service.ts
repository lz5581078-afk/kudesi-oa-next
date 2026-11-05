import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  PROVINCES, buildAutomaticRecommendations, buildEstimateRows, estimateEdges, expandParcelEstimates, groupAutomaticRecommendations, ruleFromRecordData, sortRecommendationRules, todayInChina,
  validParcelLimit, type EstimateRow, type PriceGroup, type PriceRule,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Company, ResourceLink, ResourceRecord } from '../entities';
import { resolveSource, syncBranchRules, syncVersionRules, versionEnabled } from './express-rules';
import { readFreightSnapshot } from './express-estimate-snapshot';
import { FilesService } from '../integrations/files.service';
import { ResourcesService, recordVersion } from './resources.service';

type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

const HIERARCHY = ['finance-express-carriers', 'finance-express-branches', 'finance-express-versions', 'finance-express-prices'];
import { DEFAULT_PARCEL_LIMIT, buildPriceGroups } from './express-groups';
export { DEFAULT_PARCEL_LIMIT, buildPriceGroups };

/** 价格规则输入（比资料字段少，金额一律是分） */
export interface RuleInput {
  note?: string;
  province: string;
  shipWeightMin?: number | null;
  shipWeightMax?: number | null;
  minExclusive?: boolean;
  maxExclusive?: boolean;
  fixedPrice?: number | null;
  firstWeight?: number | null;
  firstPrice?: number | null;
  extraPrice?: number | null;
}

export interface SurchargeInput {
  note?: string;
  name: string;
  effectiveStart?: string;
  effectiveEnd?: string;
  areaScope?: string;
  chargeType: 'fixed' | 'percent' | 'per_kg';
  amount?: number | null;
  percent?: number | null;
  weightMode?: 'all' | 'below' | 'above' | 'between';
  weightStart?: number | null;
  weightEnd?: number | null;
}

@Injectable()
export class ExpressService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly resources: ResourcesService, @Optional() private readonly files?: FilesService) {}

  private async all(em: EntityManager, companyId: number, types: string[]) {
    return em.find(ResourceRecord, { where: { companyId, type: In(types) }, order: { id: 'ASC' } });
  }

  private async load(em: EntityManager, user: AuthUser, type: string, id: number) {
    const r = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type } });
    if (!r) throw new NotFoundException('记录不存在');
    return r;
  }

  /** 系统生成的记录（快照、分区建议、识别记录）直接落库：不走表单校验，也不给人手工改 */
  private async saveSystem(em: EntityManager, user: AuthUser, type: string, title: string, data: Data, uniqueKey: string | null = null, status = 'active') {
    return em.save(ResourceRecord, em.create(ResourceRecord, {
      companyId: user.companyId, type, title: title.slice(0, 200), uniqueKey, status, statusReason: null, searchText: title.slice(0, 200).toLowerCase(), data, secrets: null, createdBy: user.id, updatedBy: user.id,
    }));
  }

  // ---------- 层级总览 ----------

  async tree(user: AuthUser) {
    const rows = await this.all(this.dataSource.manager, user.companyId, [...HIERARCHY, 'finance-express-fee-batches', 'finance-express-surcharges', 'finance-express-recognitions']);
    const by = (t: string) => rows.filter((r) => r.type === t);
    const prices = by('finance-express-prices');
    const surcharges = by('finance-express-surcharges');
    const day = todayInChina();
    const carriers = by('finance-express-carriers');
    const branches = by('finance-express-branches');
    return {
      carriers: carriers.map((c) => ({
        id: c.id, name: c.title, status: c.status, defaultBranchId: num(c.data.defaultBranchId), note: str(c.data.note),
        branches: branches.filter((b) => b.data.carrierId === c.id).map((b) => ({
          id: b.id, name: b.title, status: b.status, jstLogisticsName: str(b.data.jstLogisticsName), contactName: str(b.data.contactName), contactPhone: str(b.data.contactPhone), currentVersionId: num(b.data.currentVersionId),
          isDefault: c.data.defaultBranchId === b.id,
          versions: by('finance-express-versions').filter((v) => v.data.branchId === b.id).map((v) => {
            const own = prices.filter((p) => p.data.versionId === v.id);
            const start = str(v.data.effectiveStart), end = str(v.data.effectiveEnd);
            const inDate = !(start && start > day) && !(end && end < day);
            return {
              id: v.id, name: v.title, status: v.status, createdAt: v.createdAt, remark: str(v.data.remark), attachmentName: str(v.data.attachmentName), recognitionCount: by('finance-express-recognitions').filter(r => r.data.versionId === v.id).length, ruleCount: own.filter(r => (r.data.source || 'manual') === resolveSource(v, own)).length, cooperationStatus: str(v.data.cooperationStatus) || 'pending', priceSource: str(v.data.priceSource), effectiveStart: start, effectiveEnd: end,
              shippingWeightMin: num(v.data.shippingWeightMin), shippingWeightMax: num(v.data.shippingWeightMax), isCurrent: b.data.currentVersionId === v.id,
              aiRuleCount: own.filter((p) => p.data.source === 'ai').length, manualRuleCount: own.filter((p) => (p.data.source ?? 'manual') === 'manual').length,
              surchargeCount: surcharges.filter((s) => s.data.versionId === v.id).length,
              // 现在是否真的参与运费预估
              inUse: versionEnabled(v, b, c) && inDate,
            };
          }),
        })),
      })),
    };
  }

  /** 一个版本的全部内容：规则（AI 和手工两套）、加收批次、识别记录 */
  async versionDetail(user: AuthUser, versionId: number) {
    const em = this.dataSource.manager;
    const v = await this.load(em, user, 'finance-express-versions', versionId);
    const branch = await this.load(em, user, 'finance-express-branches', num(v.data.branchId) ?? -1);
    const carrier = await this.load(em, user, 'finance-express-carriers', num(branch.data.carrierId) ?? -1);
    const rows = await this.all(em, user.companyId, ['finance-express-prices', 'finance-express-fee-batches', 'finance-express-surcharges', 'finance-express-recognitions']);
    const mine = rows.filter((r) => r.data.versionId === versionId);
    const pick = (t: string) => mine.filter((r) => r.type === t);
    const recognitionTime = (record: ResourceRecord) => {
      const parsed = Date.parse(str(record.data.createdAtKey));
      return Number.isFinite(parsed) ? parsed : record.createdAt.getTime();
    };
    return {
      version: { id: v.id, name: v.title, status: v.status, data: v.data },
      branch: { id: branch.id, name: branch.title, jstLogisticsName: str(branch.data.jstLogisticsName) },
      carrier: { id: carrier.id, name: carrier.title },
      effectiveSource: resolveSource(v, pick('finance-express-prices')),
      rules: pick('finance-express-prices').map((r) => ({ ...r.data, id: r.id, source: str(r.data.source) || 'manual', version: recordVersion(r) })),
      batches: pick('finance-express-fee-batches').map((r) => ({ id: r.id, status: r.status, createdAtKey: r.createdAt, ...r.data })),
      surcharges: pick('finance-express-surcharges').map((r) => ({ id: r.id, status: r.status, ...r.data })),
      recognitions: pick('finance-express-recognitions')
        .sort((a, b) => recognitionTime(b) - recognitionTime(a) || b.id - a.id)
        .map((r) => ({ id: r.id, status: r.status, ...r.data, createdAtKey: r.data.createdAtKey || r.createdAt.toISOString() })),
    };
  }

  // ---------- 价格规则整表替换（矩阵编辑 / AI 识别确认共用） ----------

  /** 直接删记录和它的引用关系（不逐条留日志；调用方在版本上留一条汇总日志） */
  private async dropRecords(em: EntityManager, companyId: number, ids: number[], cleanup?: string[]) {
    if (!ids.length) return;
    if (cleanup && this.files) {
      for (const record of await em.find(ResourceRecord, { where: { companyId, id: In(ids) } })) cleanup.push(...await this.files.deleteAllFor(em, companyId, record.type, record.id));
    }
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      await em.delete(ResourceLink, { companyId, sourceId: In(part) });
      await em.delete(ResourceLink, { companyId, targetId: In(part) });
      await em.delete(ResourceRecord, { companyId, id: In(part) });
    }
  }

  async replaceRules(user: AuthUser, versionId: number, source: 'ai' | 'manual', rules: RuleInput[], note: string, activate = false) {
    if (!['ai', 'manual'].includes(source)) throw new BadRequestException('价格来源不合法');
    if (activate && source !== 'manual') throw new BadRequestException('手工确认只支持手工价格');
    if (rules.length > 3000) throw new BadRequestException('一次最多保存 3000 条价格规则');
    return this.dataSource.transaction(em => this.replaceRulesInTransaction(em, user, versionId, source, rules, note, activate));
  }

  private async replaceRulesInTransaction(em: EntityManager, user: AuthUser, versionId: number, source: 'ai' | 'manual', rules: RuleInput[], note: string, activate = false) {
    const version = await this.load(em, user, 'finance-express-versions', versionId);
    const old = (await this.resources.findWhere(em, user.companyId, 'finance-express-prices', 'versionId', versionId)).filter((r) => ((r.data.source as string) || 'manual') === source);
    await this.dropRecords(em, user.companyId, old.map((r) => r.id));
    let created = 0;
    for (const [i, r] of rules.entries()) {
      try {
        await this.resources.createRecord(em, user, 'finance-express-prices', {
          versionId, source, note: r.note, province: r.province, shipWeightMin: r.shipWeightMin ?? 0, shipWeightMax: r.shipWeightMax ?? undefined, minExclusive: r.minExclusive ? true : undefined, maxExclusive: r.maxExclusive ? true : undefined,
          fixedPrice: r.fixedPrice ?? undefined, firstWeight: r.fixedPrice == null ? r.firstWeight ?? undefined : undefined, firstPrice: r.fixedPrice == null ? r.firstPrice ?? undefined : undefined, extraPrice: r.fixedPrice == null ? r.extraPrice ?? undefined : undefined,
        });
        created++;
      } catch (e) {
        throw new BadRequestException(`第 ${i + 1} 条（${r.province}）：${(e as Error).message}`);
      }
    }
    const patch: Data = { rulesUpdatedAtKey: new Date().toISOString() };
    if (activate || !version.data.priceSource) patch.priceSource = source;
    if (activate && !version.data.attachmentName) patch.attachmentName = '手工创建价格表';
    await this.resources.patchData(em, user, 'finance-express-versions', versionId, patch, `${note}：${source === 'ai' ? 'AI 识别' : '手工'}价格 ${created} 条（原有 ${old.length} 条）`);
    if (activate) {
      await syncVersionRules(this.resources, em, user, versionId);
      await this.saveSystem(em, user, 'finance-express-recognitions', '手工创建价格表', { label: '手工创建价格表', versionId, recognitionType: 'manual_price', fileName: '手工录入', modelName: '-', resultText: `${created} 条价格规则`, resultCount: created, createdAtKey: new Date().toISOString() }, null, 'recorded');
    }
    return { created, removed: old.length };
  }

  // ---------- 级联删除 ----------

  private async unlink(em: EntityManager, companyId: number, sourceId: number, targetId: number) {
    await em.delete(ResourceLink, { companyId, sourceId, targetId });
  }

  /** 先清掉版本下的全部内容，再清掉网点对它的引用；最后由调用方删版本本身 */
  private async emptyVersion(em: EntityManager, user: AuthUser, version: ResourceRecord, cleanup: string[], selectReplacement = true) {
    const kids = await this.all(em, user.companyId, ['finance-express-prices', 'finance-express-fee-batches', 'finance-express-surcharges', 'finance-express-recognitions']);
    await this.dropRecords(em, user.companyId, kids.filter((k) => k.data.versionId === version.id).map((k) => k.id), cleanup);
    const branch = await em.findOne(ResourceRecord, { where: { id: num(version.data.branchId) ?? -1, companyId: user.companyId, type: 'finance-express-branches' } });
    if (branch && branch.data.currentVersionId === version.id) {
      const next = selectReplacement ? (await this.resources.findWhere(em, user.companyId, 'finance-express-versions', 'branchId', branch.id)).filter(row => row.id !== version.id).sort((a, b) => a.id - b.id)[0] : undefined;
      await this.resources.patchData(em, user, 'finance-express-branches', branch.id, { currentVersionId: next?.id ?? null }, `价格版本「${version.title}」被删除，当前版本改为${next ? `「${next.title}」` : '空'}`);
      await this.unlink(em, user.companyId, branch.id, version.id);
      if (next) await em.save(ResourceLink, em.create(ResourceLink, { companyId: user.companyId, sourceType: 'finance-express-branches', sourceId: branch.id, relation: 'currentVersionId', targetType: 'finance-express-versions', targetId: next.id }));
      if (selectReplacement) await syncBranchRules(this.resources, em, user, branch.id);
    }
  }

  private async deleteHierarchy(user: AuthUser, type: string, id: number, reason: string, empty: (em: EntityManager, record: ResourceRecord, cleanup: string[]) => Promise<void>) {
    if (!this.files) throw new Error('快递删除缺少附件清理服务');
    const cleanup: string[] = [];
    await this.dataSource.transaction(async em => {
      await this.lockEstimates(em, user);
      const record = await this.load(em, user, type, id);
      await empty(em, record, cleanup);
      await this.resources.removeRecord(em, user, type, id, reason, cleanup);
    });
    await this.files.deleteObjects(user.companyId, cleanup);
    return { ok: true };
  }

  async deleteVersion(user: AuthUser, id: number, reason: string) {
    return this.deleteHierarchy(user, 'finance-express-versions', id, reason, (em, version, cleanup) => this.emptyVersion(em, user, version, cleanup));
  }

  private async emptyBranch(em: EntityManager, user: AuthUser, branch: ResourceRecord, cleanup: string[]) {
    for (const v of await this.resources.findWhere(em, user.companyId, 'finance-express-versions', 'branchId', branch.id)) {
      await this.emptyVersion(em, user, v, cleanup, false);
      await this.dropRecords(em, user.companyId, [v.id], cleanup);
    }
    const carrier = await em.findOne(ResourceRecord, { where: { id: num(branch.data.carrierId) ?? -1, companyId: user.companyId, type: 'finance-express-carriers' } });
    if (carrier && carrier.data.defaultBranchId === branch.id) {
      const next = (await this.resources.findWhere(em, user.companyId, 'finance-express-branches', 'carrierId', carrier.id)).find((b) => b.id !== branch.id);
      await this.resources.patchData(em, user, 'finance-express-carriers', carrier.id, { defaultBranchId: next?.id ?? null }, `网点「${branch.title}」被删除，默认网点改为${next ? `「${next.title}」` : '空'}`);
      await this.unlink(em, user.companyId, carrier.id, branch.id);
      if (next) await em.save(ResourceLink, em.create(ResourceLink, { companyId: user.companyId, sourceType: 'finance-express-carriers', sourceId: carrier.id, relation: 'defaultBranchId', targetType: 'finance-express-branches', targetId: next.id }));
    }
  }

  async deleteBranch(user: AuthUser, id: number, reason: string) {
    return this.deleteHierarchy(user, 'finance-express-branches', id, reason, (em, branch, cleanup) => this.emptyBranch(em, user, branch, cleanup));
  }

  async deleteCarrier(user: AuthUser, id: number, reason: string) {
    return this.deleteHierarchy(user, 'finance-express-carriers', id, reason, async (em, carrier, cleanup) => {
      for (const b of await this.resources.findWhere(em, user.companyId, 'finance-express-branches', 'carrierId', id)) {
        await this.emptyBranch(em, user, b, cleanup);
        await this.dropRecords(em, user.companyId, [b.id], cleanup);
      }
      await this.unlink(em, user.companyId, carrier.id, num(carrier.data.defaultBranchId) ?? -1);
    });
  }

  async deleteSurchargeBatch(user: AuthUser, id: number, reason: string) {
    return this.deleteHierarchy(user, 'finance-express-fee-batches', id, reason, async (em, _batch, cleanup) => {
      await this.dropRecords(em, user.companyId, (await this.resources.findWhere(em, user.companyId, 'finance-express-surcharges', 'batchId', id)).map((s) => s.id), cleanup);
    });
  }

  // ---------- AI 识别确认 ----------

  async confirmPriceRecognition(user: AuthUser, versionId: number, p: { rules: RuleInput[]; fileName?: string; modelName?: string; effectiveStart?: string; effectiveEnd?: string; extraRemark?: string }) {
    if (!p.rules.length || p.rules.length > 3000) throw new BadRequestException('请提交 1 到 3000 条价格规则');
    return this.dataSource.transaction(async (em) => {
      const res = await this.replaceRulesInTransaction(em, user, versionId, 'ai', p.rules, '确认 AI 识别结果');
      const v = await this.load(em, user, 'finance-express-versions', versionId);
      const patch: Data = { priceSource: str(v.data.priceSource) || 'ai' };
      if (p.effectiveStart) patch.effectiveStart = p.effectiveStart;
      if (p.effectiveEnd) patch.effectiveEnd = p.effectiveEnd;
      if (p.fileName) patch.attachmentName = p.fileName;
      const remarks = [...new Set(p.rules.map(rule => rule.note?.trim()).filter((note): note is string => Boolean(note)))];
      const additions = [p.extraRemark?.trim() || '', remarks.length ? `规则备注：\n${remarks.map(note => `- ${note}`).join('\n')}` : ''].filter(Boolean);
      if (additions.length) {
        const uploadedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        const addition = `【${uploadedAt} 上传价格表识别出的附加内容】\n文件：${p.fileName || '-'}\n${additions.join('\n')}`;
        const old = str(v.data.remark).trim();
        const next = `${old ? `${old}\n\n` : ''}${addition}`;
        if (next.length > 20000) throw new BadRequestException('追加识别说明后合作备注超过20000字，请先整理版本备注后重试');
        patch.remark = next;
      }
      await this.resources.updateRecord(em, user, 'finance-express-versions', versionId, patch, '确认 AI 识别价格：保留既有最终价格依据，更新本次日期和原始文件');
      await this.saveSystem(em, user, 'finance-express-recognitions', `价格表识别 ${p.fileName ?? ''}`, {
        label: `价格表识别 ${p.fileName ?? ''}`, versionId, recognitionType: 'price_table', fileName: p.fileName, modelName: p.modelName, resultText: `${res.created} 条价格规则`, resultCount: res.created, createdAtKey: new Date().toISOString(),
      }, null, 'recorded');
      // 价格来源变了，规则状态要重新对齐
      await syncVersionRules(this.resources, em, user, versionId);
      return res;
    });
  }

  async confirmSurchargeRecognition(user: AuthUser, versionId: number, p: { batchName: string; batchNote?: string; rows: SurchargeInput[]; fileName?: string; modelName?: string; evidenceFileId?: number }, source: 'ai' | 'manual' = 'ai') {
    if (!p.rows.length) throw new BadRequestException('没有可保存的加收规则');
    return this.dataSource.transaction(async (em) => {
      await this.load(em, user, 'finance-express-versions', versionId);
      const batch = await this.resources.createRecord(em, user, 'finance-express-fee-batches', { versionId, note: p.batchNote, batchName: p.batchName.trim() || `加收通知 ${todayInChina()}`, source, fileName: p.fileName || (source === 'manual' ? '手工新增' : undefined), modelName: p.modelName, ...(p.evidenceFileId ? { evidence: [p.evidenceFileId] } : {}) });
      let created = 0;
      for (const [i, r] of p.rows.entries()) {
        try {
          await this.resources.createRecord(em, user, 'finance-express-surcharges', {
            versionId, batchId: batch.id, note: r.note, name: r.name, effectiveStart: r.effectiveStart || undefined, effectiveEnd: r.effectiveEnd || undefined, areaScope: r.areaScope || undefined, chargeType: r.chargeType,
            amount: r.amount ?? undefined, percent: r.percent ?? undefined, weightMode: r.weightMode || 'all', weightStart: r.weightStart ?? undefined, weightEnd: r.weightEnd ?? undefined, fileName: p.fileName,
          });
          created++;
        } catch (e) {
          throw new BadRequestException(`第 ${i + 1} 条加收（${r.name}）：${(e as Error).message}`);
        }
      }
      await this.saveSystem(em, user, 'finance-express-recognitions', `${source === 'manual' ? '手工新增加收' : '加收通知识别'} ${p.fileName ?? ''}`, {
        label: `${source === 'manual' ? '手工新增加收' : '加收通知识别'} ${p.fileName ?? ''}`, versionId, recognitionType: source === 'manual' ? 'manual_surcharge' : 'surcharge_notice', fileName: p.fileName, modelName: p.modelName, resultText: `${created} 条加收规则`, resultCount: created, createdAtKey: new Date().toISOString(),
      }, null, 'recorded');
      return { batchId: batch.id, created };
    });
  }

  // ---------- 预估运费一览 ----------

  private async groupsNow(em: EntityManager, companyId: number) {
    return buildPriceGroups(await this.all(em, companyId, [...HIERARCHY]), todayInChina());
  }

  private async snapshot(em: EntityManager, companyId: number) {
    return em.findOne(ResourceRecord, { where: { companyId, type: 'finance-freight-estimates', uniqueKey: 'default' } });
  }

  async parcelLimit(companyId: number, em: EntityManager = this.dataSource.manager): Promise<number> {
    const snap = await this.snapshot(em, companyId);
    const v = snap ? num(snap.data.parcelLimit) : null;
    return validParcelLimit(v) ? v : DEFAULT_PARCEL_LIMIT;
  }

  private async overrideRows(em: EntityManager, companyId: number) {
    return (await em.find(ResourceRecord, { where: { companyId, type: 'finance-freight-overrides', status: 'active' }, order: { id: 'ASC' } }))
      .map((r) => ({ id: r.id, weightFrom: num(r.data.weightFrom) ?? 0, weightTo: num(r.data.weightTo) ?? 0, amount: num(r.data.amount), reason: str(r.data.reason) }))
      .filter((o) => o.amount !== null);
  }

  /** 现算：自动估价 + 手工金额。手工金额只对单包范围内的标准重量段生效，拆包段会按包裹重量自动沿用 */
  async computeEstimates(em: EntityManager, companyId: number, parcelLimit: number) {
    const groups = await this.groupsNow(em, companyId);
    const base: EstimateRow[] = buildEstimateRows(groups, PROVINCES, parcelLimit);
    const overrides = await this.overrideRows(em, companyId);
    const edgeKeys = new Set(base.map((r) => r.key));
    for (const o of overrides) {
      const row = base.find((r) => r.start === o.weightFrom && r.end === o.weightTo);
      if (row) row.manualAmount = o.amount;
    }
    const rows = expandParcelEstimates(base, parcelLimit).sort((a, b) => a.end - b.end || a.start - b.start);
    return { rows, groups: groups.length, overrides, orphanOverrides: overrides.filter((o) => !edgeKeys.has(`${o.weightFrom}-${o.weightTo}`)) };
  }

  async getEstimates(user: AuthUser) {
    const em = this.dataSource.manager;
    const snap = await this.snapshot(em, user.companyId);
    const records = await this.all(em, user.companyId, HIERARCHY);
    const saved = readFreightSnapshot(snap ?? undefined, records);
    const overrides = await this.overrideRows(em, user.companyId);
    const keys = new Set(saved.baseRows.map(row => row.key));
    return { parcelLimit: saved.parcelLimit, calculatedAt: saved.calculatedAt, revision: saved.revision, requiresRecalculation: saved.requiresRecalculation, cooperatingGroups: buildPriceGroups(records, todayInChina()).length, rows: saved.rows, overrides, orphanOverrides: overrides.filter(row => !keys.has(`${row.weightFrom}-${row.weightTo}`)) };
  }

  private async lockEstimates(em: EntityManager, user: AuthUser) {
    const company = await em.findOne(Company, { where: { id: user.companyId }, lock: { mode: 'pessimistic_write' } });
    if (!company) throw new NotFoundException('公司不存在');
  }

  private snapshotRevision(snap: ResourceRecord | null) {
    const value = num(snap?.data.revision);
    return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : snap ? 1 : 0;
  }

  private async persistSnapshot(em: EntityManager, user: AuthUser, limit: number) {
    const out = await this.computeEstimates(em, user.companyId, limit);
    const snap = await this.snapshot(em, user.companyId);
    const baseRows = out.rows.filter(row => !row.parcels);
    const data: Data = { label: '预估运费快照', scope: 'default', parcelLimit: limit, revision: this.snapshotRevision(snap) + 1, calculatedAt: new Date().toISOString(), rowsJson: JSON.stringify(baseRows) };
    if (snap) { snap.data = data; snap.updatedBy = user.id; await em.save(ResourceRecord, snap); }
    else await this.saveSystem(em, user, 'finance-freight-estimates', '预估运费快照', data, 'default');
  }

  /** Only an explicit recalculation changes automatic quotations and their provenance. */
  async recalculate(user: AuthUser, parcelLimit?: number, revision?: number) {
    if (parcelLimit !== undefined && !validParcelLimit(parcelLimit)) throw new BadRequestException('单包重量上限要填 1 到 100 之间的整数（公斤）');
    await this.dataSource.transaction(async em => {
      await this.lockEstimates(em, user);
      const snap = await this.snapshot(em, user.companyId);
      if (revision !== undefined && revision !== this.snapshotRevision(snap)) throw new ConflictException('预估快递费已由其他人更新，请刷新页面核对后重试。');
      await this.persistSnapshot(em, user, parcelLimit ?? await this.parcelLimit(user.companyId, em));
    });
    return this.getEstimates(user);
  }

  async setParcelLimit(user: AuthUser, limit: number) { return this.recalculate(user, limit); }

  private async writeOverrides(em: EntityManager, user: AuthUser, rows: Array<{ weightFrom: number; weightTo: number; amount: number | null; reason?: string }>, revision?: number) {
    const snap = await this.snapshot(em, user.companyId);
    if (!snap) throw new BadRequestException('请先重新计算生成预估运费，再保存手工调整');
    if (revision !== undefined && revision !== this.snapshotRevision(snap)) throw new ConflictException('预估快递费已由其他人更新，请刷新页面核对后重试。');
    const limit = await this.parcelLimit(user.companyId, em);
    const edges = estimateEdges(limit);
    const seen = new Set<string>();
    let original: unknown;
    try { original = JSON.parse(str(snap.data.rowsJson)); } catch { throw new BadRequestException('预估运费快照无法读取，请重新计算'); }
    if (!Array.isArray(original)) throw new BadRequestException('预估运费快照无法读取，请重新计算');
    const saved = original.filter((row): row is Record<string, unknown> => row && typeof row === 'object' && !row.parcels);
    const existingRows = await this.overrideRows(em, user.companyId);
    for (const row of rows) {
      const key = `${row.weightFrom}-${row.weightTo}`;
      if (seen.has(key)) throw new BadRequestException('不能重复提交同一重量段');
      seen.add(key);
      const edge = edges.findIndex((value, i) => i > 0 && edges[i - 1] === row.weightFrom && value === row.weightTo);
      if (edge < 0 || !saved.some(item => item.start === row.weightFrom && item.end === row.weightTo)) throw new BadRequestException(`只能给单包范围内的标准重量段设手工运费（当前单包上限 ${limit}kg）；超过的重量按拆包自动累加`);
      if (row.amount !== null && (!Number.isSafeInteger(row.amount) || row.amount < 0 || row.amount > 100_000_000)) throw new BadRequestException('手工运费必须是有效的非负整数分金额');
    }
    for (const row of rows) {
      const existing = existingRows.find(item => item.weightFrom === row.weightFrom && item.weightTo === row.weightTo);
      const reason = row.reason?.trim();
      if (row.amount === null) { if (existing) await this.resources.removeRecord(em, user, 'finance-freight-overrides', existing.id, reason || '取消手工运费'); }
      else if (existing) await this.resources.updateRecord(em, user, 'finance-freight-overrides', existing.id, { amount: row.amount, reason: reason || undefined });
      else await this.resources.createRecord(em, user, 'finance-freight-overrides', { weightFrom: row.weightFrom, weightTo: row.weightTo, amount: row.amount, reason: reason || undefined });
      const savedRow = saved.find(item => item.start === row.weightFrom && item.end === row.weightTo)!;
      savedRow.manualAmount = row.amount;
    }
    await this.resources.patchData(em, user, 'finance-freight-estimates', snap.id, { rowsJson: JSON.stringify(saved), revision: this.snapshotRevision(snap) + 1 }, '保存预估运费手工调整');
  }

  async saveOverrides(user: AuthUser, revision: number, rows: Array<{ weightFrom: number; weightTo: number; amount: number | null }>) {
    if (rows.length > 500) throw new BadRequestException('一次最多保存500个重量段');
    await this.dataSource.transaction(async em => { await this.lockEstimates(em, user); await this.writeOverrides(em, user, rows, revision); });
    return this.getEstimates(user);
  }

  async setOverride(user: AuthUser, weightFrom: number, weightTo: number, amountCents: number | null, reason?: string) {
    await this.dataSource.transaction(async em => { await this.lockEstimates(em, user); await this.writeOverrides(em, user, [{ weightFrom, weightTo, amount: amountCents, reason }]); });
    return this.getEstimates(user);
  }

  // ---------- 分区建议生成记录 ----------

  async generateZoneRun(user: AuthUser, maxWeightKg: number) {
    if (!(maxWeightKg > 0) || maxWeightKg > 1000) throw new BadRequestException('生成上限要在 0 到 1000 公斤之间');
    return this.dataSource.transaction(async (em) => {
      await this.lockEstimates(em, user);
      const groups = await this.groupsNow(em, user.companyId);
      if (!groups.length) throw new BadRequestException('现在没有“合作中”的当前价格版本，没法生成分区建议。请先到快递价格里把网点的当前版本设为“合作中”。');
      const raw = buildAutomaticRecommendations(groups, PROVINCES, maxWeightKg);
      const rules = sortRecommendationRules(groupAutomaticRecommendations(raw));
      if (!rules.length) throw new BadRequestException('当前合作价格表没有可生成的有效分区规则，请先检查生效日期、重量范围和报价。');
      const combinationCount = raw.filter(row => row.carrierName).length;
      const prev = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-zone-runs' }, select: ['id', 'data'] });
      const sequence = prev.reduce((m, r) => Math.max(m, num(r.data.sequence) ?? 0), 0) + 1;
      const now = new Date().toISOString();
      const rec = await this.saveSystem(em, user, 'finance-zone-runs', `第 ${sequence} 次分区建议`, {
        label: `第 ${sequence} 次分区建议`, sequence, createdAtKey: now, maxWeightKg, cooperatingVersionCount: groups.length, combinationCount, ruleCount: rules.length, rowsJson: JSON.stringify(rules),
      });
      return { id: rec.id, sequence, createdAt: now, maxWeightKg, cooperatingVersionCount: groups.length, combinationCount, ruleCount: rules.length };
    });
  }

  async listZoneRuns(user: AuthUser, page: number, pageSize: number) {
    const rows = (await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-zone-runs' }, order: { id: 'DESC' } }));
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    return {
      total: rows.length, page, pageSize,
      items: slice.map((r) => ({ id: r.id, sequence: num(r.data.sequence), createdAt: str(r.data.createdAtKey), maxWeightKg: num(r.data.maxWeightKg), cooperatingVersionCount: num(r.data.cooperatingVersionCount), combinationCount: num(r.data.combinationCount), ruleCount: num(r.data.ruleCount) })),
    };
  }

  async getZoneRun(user: AuthUser, id: number) {
    const r = await this.load(this.dataSource.manager, user, 'finance-zone-runs', id);
    let rules: unknown[] = [];
    try { rules = JSON.parse(str(r.data.rowsJson)); } catch { rules = []; }
    return { id: r.id, sequence: num(r.data.sequence), createdAt: str(r.data.createdAtKey), maxWeightKg: num(r.data.maxWeightKg), cooperatingVersionCount: num(r.data.cooperatingVersionCount), ruleCount: rules.length, rules };
  }

  async deleteZoneRun(user: AuthUser, id: number) {
    await this.dataSource.transaction(async (em) => {
      await this.load(em, user, 'finance-zone-runs', id);
      await em.delete(ResourceRecord, { id, companyId: user.companyId });
    });
    return { ok: true };
  }
}
