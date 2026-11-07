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

    // Fibe Mobile (ES-231): false = staff-only (default). Audience NULL = every member, else that wing / office only.
    @Column({ name: 'show_on_mobile', type: 'boolean', default: false })
    showOnMobile: boolean;

    @Column({ name: 'audience_wing', type: 'varchar', length: 5, nullable: true })
    audienceWing: string | null;

    @Column({ name: 'audience_office', type: 'integer', nullable: true })
    audienceOffice: number | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
