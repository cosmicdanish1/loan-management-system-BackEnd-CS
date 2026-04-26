import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum LicenseStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
}

@Entity('license_keys')
export class LicenseKey {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, length: 50 })
  key: string;

  @Column({ nullable: true, length: 100 })
  customer_name: string;

  @Column({
    type: 'enum',
    enum: LicenseStatus,
    default: LicenseStatus.PENDING,
  })
  status: LicenseStatus;

  @Column({ type: 'timestamp', nullable: true })
  activated_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  expires_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  grace_ends_at: Date | null;

  @Column({ nullable: true, length: 255 })
  machine_id: string;

  @Column({ nullable: true, length: 255 })
  notes: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
