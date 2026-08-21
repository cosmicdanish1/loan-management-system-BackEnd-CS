import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

export enum DashboardNoticeType {
    INFO = 'info',
    WARNING = 'warning',
    SUCCESS = 'success',
}

// Shared, LAN-wide notice board — every office PC reads/writes the same rows,
// unlike the old localStorage version which was silently per-machine.
@Entity('dashboard_notices')
export class DashboardNotice {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ length: 200 })
    title: string;

    @Column({ type: 'text' })
    message: string;

    @Column({
        type: 'enum',
        enum: DashboardNoticeType,
        default: DashboardNoticeType.INFO,
    })
    type: DashboardNoticeType;

    // Lower sorts first. New notices get a value below the current minimum so
    // they appear on top by default; drag-reorder overwrites this per id.
    @Column({ name: 'sort_order', type: 'integer', default: 0 })
    sortOrder: number;

    @Column({ name: 'posted_by', length: 100 })
    postedBy: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
