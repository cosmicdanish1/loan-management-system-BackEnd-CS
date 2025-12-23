import { Entity, PrimaryGeneratedColumn, Column, OneToMany, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { ReportScheduleDetail } from './report-schedule-detail.entity';

@Entity('report_schedule_header')
export class ReportScheduleHeader {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ type: 'varchar', length: 255 })
    schedule_name: string;

    @Column({ type: 'varchar', length: 255 })
    template_name: string;

    @Column({ type: 'varchar', length: 20, default: 'TRIAL' })
    report_type: string; // 'TRIAL', 'BS', 'PL'

    @OneToMany(() => ReportScheduleDetail, detail => detail.schedule)
    details: ReportScheduleDetail[];

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;
}
