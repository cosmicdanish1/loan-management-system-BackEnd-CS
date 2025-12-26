import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('analytics_user_sessions')
export class UserSession {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 255, unique: true })
  session_id: string;

  @Column({ type: 'integer', nullable: true })
  user_id: number; // System user ID (from user_master table)

  @Column({ type: 'varchar', length: 100, nullable: true })
  username: string; // System username (login name)

  @Column({ type: 'varchar', length: 50, nullable: true })
  member_number: string; // Member number (if user is associated with a member)

  @Column({ type: 'varchar', length: 100, nullable: true })
  user_role: string; // User role (admin, operator, member, etc.)

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  login_time: Date;

  @Column({ type: 'timestamp', nullable: true })
  logout_time: Date;

  @Column({ type: 'integer', nullable: true })
  session_duration_minutes: number;

  @Column({ type: 'inet', nullable: true })
  ip_address: string;

  @Column({ type: 'text', nullable: true })
  user_agent: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  device_type: string; // 'desktop', 'mobile', 'tablet'

  @Column({ type: 'varchar', length: 100, nullable: true })
  browser_name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  browser_version: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  os_name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  os_version: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  screen_resolution: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  timezone: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  app_version: string;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}