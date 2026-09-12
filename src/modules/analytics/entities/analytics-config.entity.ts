import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('analytics_config')
export class AnalyticsConfig {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100, unique: true })
  config_key: string;

  @Column({ type: 'text', nullable: true })
  config_value: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  config_type: string; // 'boolean', 'integer', 'string', 'json'

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'boolean', default: true })
  is_user_configurable: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @Column({ type: 'varchar', length: 100, nullable: true })
  updated_by: string;
}