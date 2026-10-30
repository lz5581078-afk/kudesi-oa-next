import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { previewProductCode } from './finance-rules';
import { ResourcesService } from './resources.service';

const TYPE = 'finance-categories';
const num = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0);

/** 商品分类目录的拖拽排序：只调整同一个上级下兄弟分类的先后（sort），不改分类本身的任何其他内容。 */
@Injectable()
export class CategoryToolsService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly resources: ResourcesService) {}

  /** 商品编码实时预览：和保存用同一套规则，不写数据 */
  previewProductCode(user: AuthUser, input: Record<string, unknown>, excludeId: number | null) {
    return previewProductCode(this.ds.manager, this.resources, user, input, excludeId);
  }

  /** 某一类（如原料档案）的整棵分类树，按现在的顺序，给“调整顺序”用；含停用的 */
  async tree(user: AuthUser, archiveType: string) {
    const all = await this.ds.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: TYPE, archivedAt: IsNull() } });
    const nodes = all.filter((c) => String(c.data.archiveType ?? '') === archiveType)
      .map((c) => ({ id: c.id, name: c.title, code: String(c.data.code ?? ''), parentId: num(c.data.parentId), sort: Number(c.data.sort) || 0, status: c.status }))
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
    return { nodes };
  }

  /**
   * orderedIds：页面上这一组兄弟分类现在想要的先后。必须同一个上级、同一棵树（同所属类型）；
   * 可以只是其中一部分（比如被隐藏的停用分类没传）——传了的几个按新顺序占住它们原来占的位置，没传的不动。
   */
  async reorder(user: AuthUser, orderedIds: number[]) {
    if (new Set(orderedIds).size !== orderedIds.length) throw new BadRequestException('分类重复了');
    return this.ds.transaction(async (em) => {
      const all = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: TYPE, archivedAt: IsNull() } });
      const byId = new Map(all.map((c) => [c.id, c]));
      const picked = orderedIds.map((id) => byId.get(id));
      if (picked.some((c) => !c)) throw new BadRequestException('有分类不存在');
      const first = picked[0]!;
      const parent = num(first.data.parentId);
      const tree = String(first.data.archiveType ?? '');
      if (picked.some((c) => num(c!.data.parentId) !== parent || String(c!.data.archiveType ?? '') !== tree)) throw new BadRequestException('只能调整同一个上级下的分类顺序');
      const sibs = all.filter((c) => num(c.data.parentId) === parent && String(c.data.archiveType ?? '') === tree)
        .sort((a, b) => (Number(a.data.sort) || 0) - (Number(b.data.sort) || 0) || a.id - b.id);
      const chosen = new Set(orderedIds);
      const slots = sibs.map((c, i) => (chosen.has(c.id) ? i : -1)).filter((i) => i >= 0);
      const next = sibs.map((c) => c.id);
      slots.forEach((slot, k) => { next[slot] = orderedIds[k]; });
      let changed = 0;
      for (const [i, id] of next.entries()) {
        const sort = (i + 1) * 10;
        if ((Number(byId.get(id)!.data.sort) || 0) === sort) continue;
        await this.resources.patchData(em, user, TYPE, id, { sort }, '调整分类顺序');
        changed++;
      }
      return { ok: true, changed };
    });
  }
}
