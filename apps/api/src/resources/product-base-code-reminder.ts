import { createChecker, NAV_SECTIONS, resolvePermissions } from '@kudesi/shared';
import { EntityManager, In } from 'typeorm';
import { Position, PositionPermission, ResourceRecord, User, UserPermissionOverride } from '../entities';
import { writeNotification } from '../outbox/write-notification';

const sourceTypes = new Set(['finance-products', 'finance-product-sources', 'finance-product-boms']);
const codeTypes = ['finance-base-codes', 'finance-bundles'] as const;
type CodeType = typeof codeTypes[number];
const labels: Record<CodeType, string> = {
  'finance-base-codes': '商品基础编码',
  'finance-bundles': '商品组合编码',
};
const reviewStates = new Set(['pending', 'reverify']);
const scopes = new WeakMap<EntityManager, Map<number, ResourceRecord>>();

export function beginProductReminder(em: EntityManager) {
  if (!em.queryRunner?.data.legacyImport) scopes.set(em, new Map());
}

export function endProductReminder(em: EntityManager) {
  scopes.delete(em);
}

export async function withProductReminder(em: EntityManager, type: string, save: () => Promise<void>) {
  if (!sourceTypes.has(type) || scopes.has(em) || em.queryRunner?.data.legacyImport) return save();
  beginProductReminder(em);
  try {
    await save();
    await finishProductReminder(em);
  } finally {
    endProductReminder(em);
  }
}

export function trackCodeReviewChange(em: EntityManager, record: ResourceRecord, before: ResourceRecord | null) {
  const scope = scopes.get(em);
  if (!scope || !Object.hasOwn(labels, record.type) || before?.status === record.status) return;
  if (reviewStates.has(record.status)) scope.set(record.id, record);
  else scope.delete(record.id);
}

async function financeMaintainers(em: EntityManager, companyId: number) {
  const positions = await em.find(Position, { where: { companyId, status: 'active' }, select: ['id', 'workspaceType'] });
  const financeIds = new Set(positions.filter(p => p.workspaceType === 'finance').map(p => p.id));
  if (!financeIds.size) return [];
  const jobIds = (user: User) => [user.positionId, ...(user.extraPositionIds ?? [])].filter((id): id is number => id != null);
  const staff = (await em.find(User, {
    where: { companyId, status: 'active' }, select: ['id', 'positionId', 'extraPositionIds', 'isCompanyAdmin'],
  })).filter(user => jobIds(user).some(id => financeIds.has(id)));
  if (!staff.length) return [];
  const [permissions, overrides] = await Promise.all([
    em.findBy(PositionPermission, { positionId: In(positions.map(p => p.id)) }),
    em.findBy(UserPermissionOverride, { userId: In(staff.map(u => u.id)) }),
  ]);
  return staff.map(user => {
    const ids = jobIds(user);
    const can = createChecker(resolvePermissions({
      isCompanyAdmin: user.isCompanyAdmin,
      positionPermissions: permissions.filter(row => ids.includes(row.positionId)).map(row => row.permission),
      overrides: overrides.filter(row => row.userId === user.id),
    }));
    return {
      id: user.id,
      types: codeTypes.filter(type => can(`resource.${type}.view`) && can(`resource.${type}.edit`)),
    };
  });
}

export async function finishProductReminder(em: EntityManager) {
  const scope = scopes.get(em);
  if (!scope?.size) return;
  const companyId = scope.values().next().value!.companyId;
  const records = await em.findBy(ResourceRecord, { companyId, id: In([...scope.keys()]) });
  const affected = records.filter(row => !row.archivedAt && reviewStates.has(row.status));
  if (!affected.length) return;

  const financePages = NAV_SECTIONS.find(section => section.id === 'finance')!.pages;
  for (const { id, types } of await financeMaintainers(em, companyId)) {
    const sections = types.flatMap(type => {
      const rows = affected.filter(row => row.type === type);
      if (!rows.length) return [];
      const examples = rows.slice(0, 3).map(row => {
        const code = String(row.data.code || row.title).slice(0, 40);
        return `${code}（${row.status === 'pending' ? '未验证' : '二次验证'}）`;
      });
      return [{ type, text: `${labels[type]} ${rows.length} 条：${examples.join('、')}${rows.length > 3 ? '等' : ''}` }];
    });
    if (!sections.length) continue;
    await writeNotification(em, {
      companyId, userId: id, kind: 'product_code_review',
      title: `商品资料变更，请核对${sections.map(section => labels[section.type]).join('和')}`,
      body: `${sections.map(section => section.text).join('\n')}\n请按需更新并完成验证。`.slice(0, 500),
      link: financePages.find(page => page.id === sections[0].type)!.path,
    });
  }
}
