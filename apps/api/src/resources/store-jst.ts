import { BadRequestException } from '@nestjs/common';
import { ExternalConfigService } from '../integrations/external-config.service';
import { JushuitanClient } from '../integrations/jushuitan.client';

export interface StoreJstShop { id: string; name: string; platform: string; expiresAt?: string | null; expiryStatus?: 'dated' | 'permanent' | 'unknown' }

/** 店铺平台授权有效期，不是 OA 的聚水潭 access_token 有效期。空/异常值绝不推断永久。 */
export function parseStoreJstExpiry(value: unknown): Pick<StoreJstShop, 'expiresAt' | 'expiryStatus'> {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^[-—\s]*(永久授权|永久有效|永久|长期有效|长期)[-—\s]*$/.test(text)) return { expiresAt: null, expiryStatus: 'permanent' };
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (m) {
    const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const valid = new Date(`${day}T00:00:00Z`);
    if (!Number.isNaN(valid.getTime()) && valid.toISOString().slice(0, 10) === day && (!m[4] || Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6] ?? 0) < 60)) {
      if (!m[7]) return { expiresAt: day, expiryStatus: 'dated' };
      const date = new Date(`${day}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] ?? '00'}${m[7]}`);
      if (!Number.isNaN(date.getTime())) {
        const chinaDay = new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
        return { expiresAt: chinaDay, expiryStatus: 'dated' };
      }
    }
  }
  return { expiresAt: null, expiryStatus: 'unknown' };
}

export function storeJstPatch(shop: StoreJstShop) {
  return { jushuitanShopName: shop.name, jushuitanExpireAt: shop.expiresAt ?? null, jushuitanExpiryStatus: shop.expiryStatus ?? 'unknown' };
}

/** 仅查询当前 OA 公司授权的聚水潭企业，绝不返回凭据或其他企业的店铺。 */
export async function storeJstShops(config: ExternalConfigService, companyId: number): Promise<StoreJstShop[]> {
  try {
    const cfg = await config.jst(companyId);
    const rows = await new JushuitanClient(cfg).pages('/open/shops/query', {}, 'datas');
    return [...new Map(rows.filter(r => String(r.co_id) === String(cfg.coid) && r.shop_id != null && String(r.shop_id).trim())
      .map(r => [String(r.shop_id), { id: String(r.shop_id), name: String(r.shop_name || r.nick || r.shop_id), platform: String(r.shop_site ?? ''), ...parseStoreJstExpiry(r.session_expired) }] as const)).values()];
  } catch (e) {
    throw new BadRequestException(e instanceof Error ? e.message : '聚水潭店铺查询失败，请稍后重试');
  }
}

/** 只在建立或修改关联时核实；已有绑定编辑其他资料不依赖外部接口，清除绑定也可离线完成。 */
export async function validateStoreJst(data: Record<string, unknown>, existing: Record<string, unknown> | undefined, load: () => Promise<StoreJstShop[]>) {
  const id = String(data.jushuitanShopId ?? '').trim();
  if (!id) {
    delete data.jushuitanShopId; delete data.jushuitanShopName;
    if (existing?.jushuitanShopId) { delete data.jushuitanExpireAt; delete data.jushuitanExpiryStatus; }
    return;
  }
  data.jushuitanShopId = id;
  if (id === String(existing?.jushuitanShopId ?? '')) {
    if (existing?.jushuitanShopName) data.jushuitanShopName = existing.jushuitanShopName;
    else delete data.jushuitanShopName;
    return;
  }
  const shop = (await load()).find(s => s.id === id);
  if (!shop) throw new BadRequestException('所选聚水潭店铺不在当前公司授权范围内，请刷新后重新选择');
  Object.assign(data, storeJstPatch(shop));
}
