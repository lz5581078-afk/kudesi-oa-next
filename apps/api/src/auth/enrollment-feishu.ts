import { Repository } from 'typeorm';
import { AuditLog } from '../entities';

/** Durable provenance also covers employees enrolled before this feature was added. */
export async function isPositionEnrollment(audits: Pick<Repository<AuditLog>, 'findOne'>, companyId: number, userId: number) {
  const row = await audits.findOne({ where: { companyId, actorId: userId, action: 'user.self-enroll', resourceType: 'staff-enrollment', resourceId: String(userId) } });
  return row?.detail?.mode === 'position';
}
