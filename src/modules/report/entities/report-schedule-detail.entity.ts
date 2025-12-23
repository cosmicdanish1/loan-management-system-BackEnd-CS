import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { ReportScheduleHeader } from './report-schedule-header.entity';

@Entity('report_schedule_details')
export class ReportScheduleDetail {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ type: 'int' })
    schedule_id: number;

    @Column({ type: 'varchar', length: 255 })
    particulars: string;

    @Column({ type: 'varchar', length: 50 })
    code_from: string;

    @Column({ type: 'varchar', length: 50 })
    code_to: string;

    @ManyToOne(() => ReportScheduleHeader, header => header.details)
    @JoinColumn({ name: 'schedule_id' })
    schedule: ReportScheduleHeader;
}
