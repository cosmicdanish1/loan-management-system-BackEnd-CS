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

    // A private note is a personal sticky note: only the user in `postedBy` sees it, until they publish it
    // (which simply clears this flag, so it becomes an ordinary notice on everyone's board).
    @Column({ name: 'is_private', type: 'boolean', default: false })
    isPrivate: boolean;

    // Set by an administrator only. Important notices stay at the top of every user's board.
    @Column({ name: 'is_important', type: 'boolean', default: false })
    isImportant: boolean;

    // Sticky-note colour chosen by the author (one of NOTE_COLORS); NULL = default.
    @Column({ name: 'color', type: 'varchar', length: 12, nullable: true })
    color: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
