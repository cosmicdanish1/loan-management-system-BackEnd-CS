import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('analytics_page_visits')
export class PageVisit {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 255 })
  session_id: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  page_name: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  window_title: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  route_path: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  component_name: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  visit_start_time: Date;

  @Column({ type: 'timestamp', nullable: true })
  visit_end_time: Date;

  @Column({ type: 'integer', nullable: true })
  duration_seconds: number;

  @Column({ type: 'integer', nullable: true })
  page_load_time_ms: number;

  @Column({ type: 'boolean', default: false })
  is_bounce: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  referrer_page: string;

  @Column({ type: 'integer', nullable: true })
  scroll_depth_percentage: number;

  @Column({ type: 'integer', default: 0 })
  interactions_count: number;

  @CreateDateColumn()
  created_at: Date;
}