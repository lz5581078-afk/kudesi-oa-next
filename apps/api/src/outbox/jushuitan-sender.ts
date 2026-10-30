import { Injectable } from '@nestjs/common';
import { ExternalConfigService } from '../integrations/external-config.service';
import { ExternalOutcomeUnknown, JushuitanClient, JsonRow } from '../integrations/jushuitan.client';
import { OutboxSender, RemoteCategory } from './outbox.service';
const text = (v: unknown) => v == null ? '' : String(v);
const normalFields = ['sku_id', 'i_id', 'name', 'short_name', 'properties_value', 'c_name', 'brand', 'unit', 'weight', 'cost_price', 'purchase_price', 'enabled'];
const aliases: Record<string, string> = { shortName: 'short_name', propertiesValue: 'properties_value', categoryName: 'c_name', costPrice: 'cost_price', purchasePrice: 'purchase_price', salePrice: 's_price', marketPrice: 'market_price', stockDisabled: 'stock_disabled', itemType: 'item_type', shelfLife: 'shelf_life', picBig: 'pic_big', supplierName: 'supplier_name', supplierSkuId: 'supplier_sku_id', supplierStyleId: 'supplier_i_id', skuCode: 'sku_code', otherCode: 'other_code', virtualCategory: 'vc_name', productionLicence: 'production_licence', productionBatchFormat: 'productionbatch_format', length: 'l', width: 'w', height: 'h' };
export class CompanyJstSender implements OutboxSender {
  readonly configured = true;
  readonly confirmationDelays = [1000, 2000, 4000];
  constructor(private readonly client: JushuitanClient, readonly targetKey: string, private readonly expectedCoid?: string, private readonly persist?: (key: string, payload: JsonRow) => Promise<void>) {}
  private async assertCompany() {
    if (!this.expectedCoid) return;
    const shops = await this.client.pages('/open/shops/query', {}, 'datas');
    if (!shops.some(s => String(s.co_id) === this.expectedCoid)) throw new Error('聚水潭令牌所属企业与配置不一致，停止操作');
  }
  private async readAt(code: string, bundle: boolean): Promise<JsonRow | null> {
    const rows = await this.client.pages(bundle ? '/open/combine/sku/query' : '/open/sku/query', { sku_ids: code }, 'datas');
    const hits = rows.filter(r => text(r.sku_id) === code);
    if (hits.length > 1) throw new Error('聚水潭编码返回多条结果，请人工核对');
    const hit = hits[0];
    if (!hit || bundle) return hit ?? null;
    // 采购价不在默认返回字段内；单独查询，保留默认字段及远端扩展数据。
    const extra = await this.client.pages('/open/sku/query', { sku_ids: code, flds: 'sku_id,purchase_price' }, 'datas');
    const price = extra.filter(r => text(r.sku_id) === code);
    if (price.length !== 1) throw new Error('聚水潭采购价查询缺失或重复，请人工核对');
    return { ...hit, ...price[0], c_name: hit.c_name ?? hit.category };
  }
  async read(code: string, kind?: string) { await this.assertCompany(); if (kind) return this.readAt(code, kind === 'bundle'); return await this.readAt(code, true) ?? await this.readAt(code, false); }
  async readCategories(): Promise<RemoteCategory[]> {
    await this.assertCompany();
    const rows = await this.client.pages('/open/category/query', {}, 'datas');
    return rows.map((r: JsonRow) => ({ id: text(r.c_id ?? r.category_id ?? r.id), name: text(r.c_name ?? r.name ?? r.category_name), parentId: text(r.parent_c_id ?? r.parent_id ?? r.parentId ?? 0), sort: r.sort == null ? null : Number(r.sort), enable: r.enable == null ? null : ![false, 0, '0', 'false'].includes(r.enable) }));
  }
  async send(job: { kind: string; idempotencyKey: string; payload: JsonRow }): Promise<void | { remoteId?: string }> {
    const p = job.payload;
    await this.assertCompany();
    if (p.targetKey !== this.targetKey) throw new Error('聚水潭目标身份不一致，请重新核对后入队');
    if (job.kind === 'category_sync') return this.category(job);
    const bundle = job.kind.startsWith('bundle_'), sku = text(p.sku_id);
    if (!sku) throw new Error('商品编码为空');
    const existing = await this.readAt(sku, bundle);
    const path = bundle ? '/open/item/combinesku/upload' : '/open/jushuitan/itemsku/upload';
    let item: JsonRow;
    if (job.kind.endsWith('_disable')) {
      if (!existing) return;
      item = bundle ? { ...existing, sku_id: sku, enabled: '禁用' } : { sku_id: sku, i_id: existing.i_id, name: existing.name, enabled: -1 };
    } else if (job.kind === 'bundle_price_update') {
      if (!existing || !Array.isArray(existing.childList)) throw new Error('无法读取原组合组成，不能只更新基本售价');
      item = { ...existing, compose_sale_price: p.compose_sale_price };
    } else if (bundle) {
      item = { ...(existing ?? {}), sku_id: sku, i_id: p.i_id, name: p.name, short_name: p.short_name, properties_value: p.properties_value, unit: p.unit, childList: (p.childList ?? []).map((c: JsonRow) => ({ ...((existing?.childList ?? []).find((old: JsonRow) => old.src_sku_id === c.src_sku_id) ?? {}), ...c })), ...(p.compose_sale_price != null ? { compose_sale_price: p.compose_sale_price } : {}) };
    } else {
      item = {}; // 普通商品接口按所传字段更新；查询字段不能原样当作上传字段。
      for (const k of normalFields) if (p[k] != null) item[k] = p[k];
      for (const [k, v] of Object.entries(p)) if (aliases[k] && v != null) item[aliases[k]] = v;
      for (let i = 1; i <= 5; i++) { if (p[`other${i}`] != null) item[`other_${i}`] = p[`other${i}`]; if (p[`otherPrice${i}`] != null) item[`other_price_${i}`] = p[`otherPrice${i}`]; }
      for (const k of ['brand', 'unit', 'weight', 'remark', 'pic', 'volume']) if (p[k] != null) item[k] = p[k];
    }
    if (!bundle && (p.c_name || p.categoryName) && !job.kind.endsWith('_disable')) {
      const categories = await this.readCategories(), wanted = text(p.c_name ?? p.categoryName), leaf = wanted.split('/').at(-1)!;
      const matches = categories.filter(c => c.name === leaf && c.enable !== false);
      if (matches.length !== 1 || categories.some(c => c.parentId === matches[0].id)) throw new Error('聚水潭分类不存在、重名或不是末级分类，请核对后同步');
      if (wanted.includes('/')) {
        const names = [leaf], seen = new Set([matches[0].id]); let parent = matches[0].parentId;
        while (parent !== '0' && parent !== '') {
          const node = categories.find(c => c.id === parent);
          if (!node || seen.has(parent)) throw new Error('聚水潭分类层级不完整');
          seen.add(parent); names.unshift(node.name); parent = node.parentId;
        }
        if (names.join('/') !== wanted) throw new Error('聚水潭分类路径与本地不一致');
      }
      item.c_name = leaf;
    }
    if (!bundle && p.labels != null) item.labels = Array.isArray(p.labels) ? p.labels : String(p.labels).split(/[,，]/).map(v => v.trim()).filter(Boolean);
    if (!bundle && p.stockDisabled != null) {
      if (!['0', '1', 'false', 'true'].includes(String(p.stockDisabled))) throw new Error('禁止同步状态不合法');
      item.stock_disabled = ['1', 'true'].includes(String(p.stockDisabled));
    }
    if (!bundle && item.enabled != null) {
      const value = String(item.enabled);
      if (['1', 'true', '启用'].includes(value)) item.enabled = 1;
      else if (value === '0') item.enabled = 0;
      else if (['-1', 'false', '禁用'].includes(value)) item.enabled = -1;
      else throw new Error('普通商品启用状态不合法');
    }
    if (!item.i_id || !item.name) throw new Error('商品款式编码或名称不完整，未发送');
    if (job.kind.endsWith('_replace')) return this.replace(job, bundle, item, existing);
    await this.client.call(path, bundle ? { is_cover: true, is_null_cover: false, items: [{ ...item, is_update_enty_sku_from_combine_sku: false }] } : { items: [item] });

  }
  private async category(job: { idempotencyKey: string; payload: JsonRow }): Promise<{ remoteId: string }> {
    if (!this.persist) throw new Error('分类同步缺少持久化通道');
    const p = job.payload, d = p.desired ?? {}, id = p.remoteId ? Number(p.remoteId) : null, parent = Number(d.parentRemoteId ?? 0);
    if (!Number.isSafeInteger(parent) || (id != null && !Number.isSafeInteger(id))) throw new Error('聚水潭分类 ID 不合法');
    const desired = { name: String(d.name), parentId: String(parent), sort: d.sort ?? 0, enable: p.op === 'retire' ? false : d.enable !== false };
    const remote = await this.readCategories();
    const state = p.transport;
    if (state?.stage === 'category-write-intent' || state?.stage === 'category-written') {
      const matches = remote.filter(c => state.remoteId ? c.id === String(state.remoteId) : c.name === desired.name && c.parentId === desired.parentId);
      if (!matches.length && desired.enable === false && id != null) return { remoteId: String(id) };
      const got = matches.length === 1 ? matches[0] : null;
      if (!got || got.name !== desired.name || got.parentId !== desired.parentId || (got.sort != null && got.sort !== desired.sort) || (got.enable != null && got.enable !== desired.enable)) throw new ExternalOutcomeUnknown('分类写入结果尚未回查一致，仅回查，不重复提交');
      return { remoteId: got.id };
    }
    if (id == null && remote.some(c => c.name === desired.name && c.parentId === desired.parentId)) throw new Error('远端已有同名分类，请重新预览并核对关联');
    p.transport = { stage: 'category-write-intent', ...(id != null ? { remoteId: String(id) } : {}) };
    await this.persist(job.idempotencyKey, p);
    let result: JsonRow;
    try { result = await this.client.call('/open/webapi/itemapi/category/addorupdate', { ...(id != null ? { c_id: id } : {}), c_name: desired.name, parent_c_id: parent, sort: desired.sort, enable: desired.enable, is_pv: false }); }
    catch (e) { if (!(e as { outcomeUnknown?: boolean }).outcomeUnknown) { delete p.transport; await this.persist(job.idempotencyKey, p); } throw e; }
    const remoteId = result.c_id ?? result.id ?? id;
    if (remoteId == null) throw new ExternalOutcomeUnknown('聚水潭未返回分类 ID，请回查');
    p.transport = { stage: 'category-written', remoteId: String(remoteId) };
    try { await this.persist(job.idempotencyKey, p); } catch { throw new ExternalOutcomeUnknown('分类已经提交，但结果记录未完成，请回查'); }
    return { remoteId: String(remoteId) };
  }

  /** 改码的每一步先落意图，再写入；未知结果只回查，不盲目重放。 */
  private async replace(job: { idempotencyKey: string; payload: JsonRow }, bundle: boolean, item: JsonRow, current: JsonRow | null) {
    if (!this.persist) throw new Error('改码缺少持久化通道');
    const p = job.payload, oldCode = text(p.oldCode);
    if (!oldCode || oldCode === item.sku_id) throw new Error('原编码不合法');
    const old = await this.readAt(oldCode, bundle);
    if (!old || old.autoid == null) throw new Error('无法核实旧商品身份，停止改码');
    const disabled = (r: JsonRow) => ['-1', '禁用'].includes(String(r.enabled));
    const state = p.transport ?? { stage: 'ready', oldAutoId: String(old.autoid), desired: item };
    if (String(old.autoid) !== state.oldAutoId) throw new Error('旧商品身份已变化，停止改码');
    const save = async (stage: string) => { state.stage = stage; p.transport = state; await this.persist!(job.idempotencyKey, p); };
    const path = bundle ? '/open/item/combinesku/upload' : '/open/jushuitan/itemsku/upload';
    const upload = async (value: JsonRow) => this.client.call(path, bundle ? { is_cover: true, is_null_cover: false, items: [{ ...value, is_update_enty_sku_from_combine_sku: false }] } : { items: [value] });
    if (state.stage === 'ready') {
      if (current) throw new Error('新编码已存在，禁止覆盖或接管');
      if (disabled(old)) throw new Error('旧商品已经禁用，请先人工核对');
      await save('disable-intent');
      try { await upload(bundle ? { ...old, enabled: '禁用' } : { sku_id: old.sku_id, i_id: old.i_id, name: old.name, enabled: -1 }); }
      catch (e) { if (!(e as { outcomeUnknown?: boolean }).outcomeUnknown) await save('ready'); throw e; }
    }
    if (state.stage === 'disable-intent') {
      const observed = await this.readAt(oldCode, bundle);
      if (!observed || !disabled(observed) || String(observed.autoid) !== state.oldAutoId) throw new ExternalOutcomeUnknown('旧编码禁用结果未确认，只允许回查');
      await save('disabled');
    }
    if (state.stage === 'disabled') {
      if (await this.readAt(text(item.sku_id), bundle)) throw new ExternalOutcomeUnknown('新编码已被占用，旧编码已禁用，请人工核对');
      await save('create-intent');
      try { await upload({ ...state.desired, enabled: bundle ? '启用' : 1 }); }
      catch (e) { if (!(e as { outcomeUnknown?: boolean }).outcomeUnknown) await save('disabled'); throw e; }
    }
    const got = await this.readAt(text(item.sku_id), bundle);
    if (!got || String(got.autoid) === state.oldAutoId || String(got.name) !== String(state.desired.name) || String(got.i_id) !== String(state.desired.i_id)) throw new ExternalOutcomeUnknown('新编码写入结果尚未确认，请回查');
    await save('verified');
  }

}
@Injectable()
export class JushuitanSenderFactory implements OutboxSender {
  readonly configured = true;
  constructor(private readonly settings: ExternalConfigService) {}
  async forCompany(companyId: number): Promise<OutboxSender> { const cfg = await this.settings.jst(companyId); return new CompanyJstSender(new JushuitanClient(cfg), cfg.targetKey, String(cfg.coid), async (key, payload) => {
      const r = await this.settings.ds.query("UPDATE outbox_jobs SET payload_json=? WHERE company_id=? AND channel='jushuitan' AND idempotency_key=? AND status='sending'", [JSON.stringify(payload), companyId, key]);
      if (!r.affectedRows) throw new Error('改码任务意图未保存，停止外部写入');
    }); }
  async send(): Promise<void> { throw new Error('必须先选择公司授权账户'); }
}
