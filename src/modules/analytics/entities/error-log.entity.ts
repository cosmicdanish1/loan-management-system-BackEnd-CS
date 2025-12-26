import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('analytics_error_logs')
export class ErrorLog {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 255 })
  session_id: string;

  @Column({ type: 'varchar', length: 255, unique: true, nullable: true })
  error_id: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  error_type: string; // 'javascript', 'api', 'database', 'validation', 'network'

  @Column({ type: 'varchar', length: 20, nullable: true })
  severity_level: string; // 'low', 'medium', 'high', 'critical'

  @Column({ type: 'text' })
  error_message: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  error_code: string;

  @Column({ type: 'text', nullable: true })
  stack_trace: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  component_name: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  file_name: string;

  @Column({ type: 'integer', nullable: true })
  line_number: number;

  @Column({ type: 'integer', nullable: true })
  column_number: number;

  @Column({ type: 'text', nullable: true })
  user_action_before_error: string;

  @Column({ type: 'text', nullable: true })
  browser_console_logs: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  network_status: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp: Date;

  @Column({ type: 'boolean', default: false })
  resolved_status: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  resolved_by: string;

  @Column({ type: 'timestamp', nullable: true })
  resolved_at: Date;

  @Column({ type: 'text', nullable: true })
  resolution_notes: string;

  @Column({ type: 'integer', default: 1 })
  occurrence_count: number;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  first_occurrence: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  last_occurrence: Date;

  @CreateDateColumn()
  created_at: Date;
}