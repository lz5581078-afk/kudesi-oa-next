import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('staff_enrollment_invites')
@Index('idx_staff_enrollment_company', ['companyId', 'id'])
export class StaffEnrollmentInvite {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true }) id!: number;
  @Column({ name: 'company_id', type: 'int', unsigned: true }) companyId!: number;
  @Index('uq_staff_enrollment_token', { unique: true })
  @Column({ name: 'token_hash', type: 'char', length: 64, select: false }) tokenHash!: string;
  @Column({ type: 'varchar', length: 12 }) mode!: 'general' | 'position';
  @Column({ name: 'position_id', type: 'int', unsigned: true, nullable: true }) positionId!: number | null;
  @Column({ name: 'employment_type', type: 'varchar', length: 16, default: 'regular' }) employmentType!: 'regular' | 'part_time' | 'temp';
  @Column({ name: 'contract_start_date', type: 'date', nullable: true }) contractStartDate!: string | null;
  @Column({ name: 'contract_end_date', type: 'date', nullable: true }) contractEndDate!: string | null;
  @Column({ name: 'created_by', type: 'int', unsigned: true }) createdBy!: number;
  @Column({ name: 'expires_at', type: 'datetime' }) expiresAt!: Date;
  @Column({ name: 'revoked_at', type: 'datetime', nullable: true }) revokedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' }) createdAt!: Date;
}
