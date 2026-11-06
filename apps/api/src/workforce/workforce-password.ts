import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { CryptoService } from '../common/crypto.service';
import type { AuthUser } from '../common/auth.decorators';
import type { User } from '../entities';

export function validateWorkforcePassword(password: string) {
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new BadRequestException('密码至少8位，且不能超过72字节');
  }
}

export async function storeWorkforcePassword(em: EntityManager, crypto: CryptoService, actor: AuthUser, person: User, password: string) {
  await em.query(
    `INSERT INTO workforce_login_secrets(company_id,user_id,password_cipher,password_hash_snapshot,updated_by)
     VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE password_cipher=VALUES(password_cipher),password_hash_snapshot=VALUES(password_hash_snapshot),updated_by=VALUES(updated_by)`,
    [actor.companyId, person.id, crypto.encrypt(password), person.passwordHash, actor.id],
  );
}
