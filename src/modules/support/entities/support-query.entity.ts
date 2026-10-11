import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export type SupportPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type SupportQueryType = 'BUG' | 'QUESTION' | 'DATA_CORRECTION' | 'FEATURE_REQUEST' | 'OTHER';
export type SupportStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
// PENDING = not delivered yet, SENT = delivered, FAILED = tried and errored,
// DISABLED = integration not configured (retried automatically once it is).
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'DISABLED';

@Entity('support_queries')
export class SupportQuery {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ type: 'varchar', length: 200 })
    subject: string;

    @Column({ type: 'text' })
    description: string;

    @Column({ type: 'varchar', length: 80, nullable: true })
    module: string | null;

    @Column({ name: 'query_type', type: 'varchar', length: 20, default: 'OTHER' })
    queryType: SupportQueryType;

    @Column({ type: 'varchar', length: 10, default: 'MEDIUM' })
    priority: SupportPriority;

    @Column({ type: 'varchar', length: 20, default: 'OPEN' })
    status: SupportStatus;

    @Column({ name: 'reporter_userid', type: 'varchar', length: 50, nullable: true })
    reporterUserId: string | null;

    @Column({ name: 'reporter_username', type: 'varchar', length: 100, nullable: true })
    reporterUsername: string | null;

    @Column({ name: 'reporter_role', type: 'varchar', length: 50, nullable: true })
    reporterRole: string | null;

    @Column({ type: 'varchar', length: 300, nullable: true })
    route: string | null;

    @Column({ name: 'app_version', type: 'varchar', length: 50, nullable: true })
    appVersion: string | null;

    @Column({ name: 'client_info', type: 'text', nullable: true })
    clientInfo: string | null;

    @Column({ name: 'screenshot_path', type: 'varchar', length: 300, nullable: true })
    screenshotPath: string | null;

    @Column({ name: 'jira_key', type: 'varchar', length: 30, nullable: true })
    jiraKey: string | null;

    @Column({ name: 'jira_status', type: 'varchar', length: 15, default: 'PENDING' })
    jiraStatus: DeliveryStatus;

    @Column({ name: 'jira_attempts', type: 'int', default: 0 })
    jiraAttempts: number;

    @Column({ name: 'jira_error', type: 'text', nullable: true })
    jiraError: string | null;

    @Column({ name: 'telegram_status', type: 'varchar', length: 15, default: 'PENDING' })
    telegramStatus: DeliveryStatus;

    @Column({ name: 'telegram_attempts', type: 'int', default: 0 })
    telegramAttempts: number;

    @Column({ name: 'telegram_error', type: 'text', nullable: true })
    telegramError: string | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt: Date;
}
