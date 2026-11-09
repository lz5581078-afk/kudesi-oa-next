import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createChecker, getResourceDef, SPECIAL_PERMISSIONS } from '@kudesi/shared';
import { DataSource, In, IsNull } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceFile, ResourceRecord } from '../entities';
import { FilesService } from '../integrations/files.service';
import { costCompositionFacts } from '../resources/cost-components';
import { INVENTORY_UNIT_SQL } from '../resources/finance-inventory-units';
import { bundleOwnership } from '../resources/product-exclusive';
import { ResourcesService } from '../resources/resources.service';
import { loadUnitLists, unitLabelFor } from '../resources/unit-options';

const BUNDLE = 'finance-bundles';
const PRODUCT = 'finance-products';
const states = In(['active', 'pending', 'verified', 'reverify']);
const bundleUnitField = getResourceDef('finance-bundle-lines')!.fields.find(f => f.key === 'unit')!;
const partUnitField = getResourceDef('finance-base-code-lines')!.fields.find(f => f.key === 'unit')!;
const productUnitField = getResourceDef(PRODUCT)!.fields.find(f => f.key === 'specUnit')!;
const str = (v: unknown) => typeof v === 'string' ? v : '';
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const ids = (values: unknown[]) => [...new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
type StockRow = { productId: number; warehouseId: number; stockUnit: string; qty: string };
type Requirement = { productId: number; unit: string; qty: number };

/** 按仓计算实际可配套数，同商品同单位的重复用料先合并。 */
function availableBundleStock(requirements: Requirement[], stock: StockRow[]): number | null {
  if (!requirements.length) return null;
  const needs = new Map<string, number>();
  for (const item of requirements) {
    if (!item.unit || !Number.isFinite(item.qty) || item.qty <= 0) return null;
    const key = JSON.stringify([item.productId, item.unit]);
    needs.set(key, (needs.get(key) ?? 0) + item.qty);
  }
  const seen = new Set<string>();
  const warehouses = new Map<number, Map<string, number>>();
  for (const row of stock) {
    const key = JSON.stringify([Number(row.productId), row.stockUnit]);
    if (!needs.has(key)) continue;
    seen.add(key);
    const balances = warehouses.get(row.warehouseId) ?? new Map<string, number>();
    balances.set(key, Number(row.qty));
    warehouses.set(row.warehouseId, balances);
  }
  if (seen.size < needs.size) return null;
  return [...warehouses.values()].reduce((total, balances) => {
    const complete = Math.min(...[...needs].map(([key, qty]) => (balances.get(key) ?? 0) / qty));
    return total + Math.max(0, Math.floor(complete + 1e-9));
  }, 0);
}

@Injectable()
export class CompanyProductsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly resources: ResourcesService,
    private readonly files: FilesService,
  ) {}

  private async categories(companyId: number) {
    const rows = await this.ds.manager.createQueryBuilder(ResourceRecord, 'r')
      .where('r.companyId = :companyId AND r.type = :type AND r.archivedAt IS NULL', { companyId, type: 'finance-categories' })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.archiveType')) = 'bundle'").getMany();
    const byId = new Map(rows.map(row => [row.id, row]));
    return rows.map(row => {
      const ancestors: number[] = [];
      const names: string[] = [];
      for (let cur: ResourceRecord | undefined = row; cur && !ancestors.includes(cur.id); cur = byId.get(Number(cur.data.parentId))) {
        ancestors.unshift(cur.id);
        names.unshift(cur.title);
      }
      return { id: row.id, name: names.join(' / '), ancestors };
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  async list(user: AuthUser, query: { category?: number; keyword?: string; page?: number }) {
    const categories = await this.categories(user.companyId);
    const page = query.page ?? 1;
    const pageSize = 24;
    const builder = this.ds.manager.createQueryBuilder(ResourceRecord, 'r')
      .where({ companyId: user.companyId, type: BUNDLE, archivedAt: IsNull(), status: states });
    const category = "JSON_EXTRACT(r.data, '$.bundleCategoryId')";
    if (query.category === 0) {
      const known = categories.map(c => c.id);
      if (known.length) builder.andWhere(`(${category} IS NULL OR CAST(${category} AS UNSIGNED) NOT IN (:...known))`, { known });
    } else if (query.category !== undefined) {
      const selected = categories.filter(c => c.ancestors.includes(query.category!)).map(c => c.id);
      if (selected.length) builder.andWhere(`CAST(${category} AS UNSIGNED) IN (:...selected)`, { selected });
      else builder.andWhere('1 = 0');
    }
    if (query.keyword?.trim()) {
      builder.andWhere(`LOCATE(:keyword, CONCAT_WS(' ', r.title, JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.name')),
        JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.shortName')), JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.propertiesValue')))) > 0`, { keyword: query.keyword.trim() });
    }
    const [rows, total] = await builder.orderBy('r.updatedAt', 'DESC').addOrderBy('r.id', 'DESC').skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    const names = new Map(categories.map(c => [c.id, c.name]));
    return { items: (await this.summaries(user.companyId, rows, names)).map(({ photos, ...item }) => ({ ...item, photo: photos[0] ?? null })),
      total, page, pageSize, categories: categories.map(({ id, name }) => ({ id, name })) };
  }

  async detail(user: AuthUser, id: number) {
    const em = this.ds.manager;
    const row = await this.find(user.companyId, id);
    const [categories, lines] = await Promise.all([
      this.categories(user.companyId), this.lines(user.companyId, [id]),
    ]);
    const [items, weight] = await Promise.all([
      this.summaries(user.companyId, [row], new Map(categories.map(c => [c.id, c.name])), lines, true),
      costCompositionFacts(em, user.companyId, row.data, lines.map(line => line.data)),
    ]);
    const can = createChecker(user.permissions);
    return { ...items[0], weightG: weight.weightG, styleCode: str(row.data.styleCode),
      ...(can(SPECIAL_PERMISSIONS.productPriceView) ? { priceCents: number(row.data.jstPriceCents) } : {}) };
  }

  async setAttributes(user: AuthUser, id: number, values: { priceRestricted: boolean; tags: string[] }) {
    if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员可以设置产品属性');
    const tags = [...new Set(values.tags.map(tag => tag.trim()).filter(tag => tag && tag !== '限价品'))];
    await this.ds.transaction(async em => {
      const row = await em.findOne(ResourceRecord, {
        where: { id, companyId: user.companyId, type: BUNDLE, archivedAt: IsNull(), status: states },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new NotFoundException('产品不存在');
      await this.resources.patchData(em, user, BUNDLE, id, { catalogPriceRestricted: values.priceRestricted, catalogTags: tags }, '设置公司产品属性', false, true);
    });
    return { priceRestricted: values.priceRestricted, tags };
  }

  private async find(companyId: number, id: number) {
    const row = await this.ds.manager.findOneBy(ResourceRecord, { id, companyId, type: BUNDLE, archivedAt: IsNull(), status: states });
    if (!row) throw new NotFoundException('产品不存在');
    return row;
  }

  private lines(companyId: number, bundleIds: number[]) {
    return this.ds.manager.createQueryBuilder(ResourceRecord, 'r')
      .where({ companyId, type: 'finance-bundle-lines', archivedAt: IsNull() })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.bundleId')) IN (:...bundleIds)", { bundleIds: bundleIds.map(String) }).orderBy('r.id').getMany();
  }

  private async summaries(companyId: number, rows: ResourceRecord[], categories: Map<number, string>, supplied?: ResourceRecord[], allPhotos = false) {
    if (!rows.length) return [];
    const em = this.ds.manager;
    const lines = supplied ?? await this.lines(companyId, rows.map(row => row.id));
    const find = (type: string, recordIds: number[]) => recordIds.length
      ? em.findBy(ResourceRecord, { companyId, type, id: In(recordIds), archivedAt: IsNull() }) : Promise.resolve([]);
    const bases = await find('finance-base-codes', ids(lines.map(line => line.data.baseCodeId)));
    const selectedIds = new Set(bases.map(base => base.id));
    bases.push(...await find('finance-base-codes', ids(bases.map(base => base.data.canonicalId)).filter(id => !selectedIds.has(id))));
    const baseById = new Map(bases.map(base => [base.id, base]));
    const composed = bases.filter(base => base.data.origin === 'composed').map(base => base.id);
    const parts = composed.length ? await em.createQueryBuilder(ResourceRecord, 'r')
      .where({ companyId, type: 'finance-base-code-lines', archivedAt: IsNull() })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.baseCodeId')) IN (:...composed)", { composed: composed.map(String) }).orderBy('r.id').getMany() : [];
    const productIds = ids([...lines, ...bases, ...parts].map(row => row.data.productId));
    const [products, owners, units, stock, files] = await Promise.all([
      find(PRODUCT, productIds), bundleOwnership(em, companyId, lines), loadUnitLists(em, companyId),
      productIds.length ? em.query<StockRow[]>(`SELECT e.account_id AS productId, e.sub_id AS warehouseId, ${INVENTORY_UNIT_SQL} AS stockUnit, SUM(e.qty) AS qty
        FROM finance_entries e WHERE e.company_id = ? AND e.kind = 'inventory' AND e.account_id IN (?) AND e.qty IS NOT NULL
        GROUP BY e.account_id, e.sub_id, stockUnit`, [companyId, productIds]) : [],
      productIds.length ? em.find(ResourceFile, { where: { companyId, resourceType: PRODUCT, fieldKey: 'photos', resourceId: In(productIds) }, order: { id: 'ASC' } }) : [],
    ]);
    const byProduct = new Map(products.map(row => [row.id, row]));
    const signers = new Map<number, Promise<{ url: string; name: string } | null>>();
    const photoUrl = (file: ResourceFile) => {
      const pending = signers.get(file.id) ?? this.files.urlOf(companyId, file.id, PRODUCT)
        .then(({ url, name }) => ({ url, name })).catch(() => null);
      signers.set(file.id, pending);
      return pending;
    };

    return Promise.all(rows.map(async row => {
      const requirements: Requirement[] = [];
      const photoProducts = new Set<number>();
      let complete = true;
      const add = (line: ResourceRecord, id: unknown, multiplier: number, main: boolean, required: boolean) => {
        const product = byProduct.get(Number(id));
        if (!product) { if (required) complete = false; return; }
        if (main) photoProducts.add(product.id);
        if (!required) return;
        const field = line.type === 'finance-base-code-lines' ? partUnitField : bundleUnitField;
        const unit = unitLabelFor(units, field, line.data, line.data.unit)
          || unitLabelFor(units, productUnitField, product.data, product.data.specUnit) || '件';
        requirements.push({ productId: product.id, unit, qty: Number(line.data.qty) * multiplier });
      };
      for (const line of lines.filter(l => Number(l.data.bundleId) === row.id && l.data.role !== 'labor')) {
        const main = line.data.role === 'main';
        const required = main || line.data.isRequired !== false;
        const selected = baseById.get(Number(line.data.baseCodeId));
        const base = selected?.data.canonicalId ? baseById.get(Number(selected.data.canonicalId)) : selected;
        if (line.data.productId) add(line, line.data.productId, 1, main, required);
        else if (base?.data.origin === 'composed') {
          const components = parts.filter(part => Number(part.data.baseCodeId) === base.id);
          if (!components.length && required) complete = false;
          for (const part of components) add(part, part.data.productId, Number(line.data.qty), main, required);
        } else add(line, base?.data.productId, 1, main, required);
      }
      const available = [...photoProducts].flatMap(id => {
        const ordered = byProduct.get(id)?.data.photos;
        const photos = files.filter(f => f.resourceId === id && f.mime.startsWith('image/'));
        return Array.isArray(ordered) ? ids(ordered).flatMap(fileId => photos.filter(f => f.id === fileId)) : photos;
      });
      const photos = allPhotos ? (await Promise.all(available.map(photoUrl))).filter(photo => photo !== null) : [];
      if (!allPhotos) {
        for (const file of available) {
          const photo = await photoUrl(file);
          if (photo) { photos.push(photo); break; }
        }
      }
      return { id: row.id, name: str(row.data.name) || row.title, code: str(row.data.code) || row.title,
        category: categories.get(Number(row.data.bundleCategoryId)) ?? '未分类', specification: str(row.data.propertiesValue),
        photos, stock: complete ? availableBundleStock(requirements, stock) : null,
        owners: [...new Set((owners.get(row.id) ?? []).map(owner => owner.ownerName).filter(Boolean))],
        priceRestricted: row.data.catalogPriceRestricted === true,
        tags: Array.isArray(row.data.catalogTags) ? row.data.catalogTags.filter((tag): tag is string => typeof tag === 'string') : [],
      };
    }));
  }
}
