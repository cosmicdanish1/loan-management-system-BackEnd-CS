import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('analytics_feature_usage')
export class FeatureUsage {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 255 })
  session_id: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  feature_category: string; // 'Reports', 'Transaction', 'Masters', etc.

  @Column({ type: 'varchar', length: 200, nullable: true })
  feature_name: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  sub_feature: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  action_type: string; // 'view', 'click', 'submit', 'download', 'print'

  @Column({ type: 'jsonb', nullable: true })
  action_details: any;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp: Date;

  @Column({ type: 'integer', nullable: true })
  execution_time_ms: number;

  @Column({ type: 'boolean', nullable: true })
  success_status: boolean;

  @Column({ type: 'text', nullable: true })
  error_message: string;

  @Column({ type: 'jsonb', nullable: true })
  user_input_data: any; // Anonymized form data structure

  @Column({ type: 'integer', nullable: true })
  result_count: number;

  @CreateDateColumn()
  created_at: Date;
}