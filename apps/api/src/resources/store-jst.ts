import { BadRequestException } from '@nestjs/common';
import { ExternalConfigService } from '../integrations/external-config.service';
import { JushuitanClient } from '../integrations/jushuitan.client';

export interface StoreJstShop { id: string; name: string; platform: string }

/** 仅查询当前 OA 公司授权的聚水潭企业，绝不返回凭据或其他企业的店铺。 */
export async function storeJstShops(config: ExternalConfigService, companyId: number): Promise<StoreJstShop[]> {
  try {
    const cfg = await config.jst(companyId);
    const rows = await new JushuitanClient(cfg).pages('/open/shops/query', {}, 'datas');
    return [...new Map(rows.filter(r => String(r.co_id) === String(cfg.coid) && r.shop_id != null && String(r.shop_id).trim())
      .map(r => [String(r.shop_id), { id: String(r.shop_id), name: String(r.shop_name || r.nick || r.shop_id), platform: String(r.shop_site ?? '') }] as const)).values()];
  } catch (e) {
    throw new BadRequestException(e instanceof Error ? e.message : '聚水潭店铺查询失败，请稍后重试');
  }
}

/** 只在建立或修改关联时核实；已有绑定编辑其他资料不依赖外部接口，清除绑定也可离线完成。 */
export async function validateStoreJst(data: Record<string, unknown>, existing: Record<string, unknown> | undefined, load: () => Promise<StoreJstShop[]>) {
  const id = String(data.jushuitanShopId ?? '').trim();
  if (!id) { delete data.jushuitanShopId; delete data.jushuitanShopName; return; }
  data.jushuitanShopId = id;
  if (id === String(existing?.jushuitanShopId ?? '')) {
    if (existing?.jushuitanShopName) data.jushuitanShopName = existing.jushuitanShopName;
    else delete data.jushuitanShopName;
    return;
  }
  const shop = (await load()).find(s => s.id === id);
  if (!shop) throw new BadRequestException('所选聚水潭店铺不在当前公司授权范围内，请刷新后重新选择');
  data.jushuitanShopName = shop.name;
}
