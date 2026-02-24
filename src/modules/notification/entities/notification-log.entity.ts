import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { Member } from '../../member/entities/member.entity';

export enum NotificationChannel {
    SMS = 'SMS',
    WHATSAPP = 'WHATSAPP',
    EMAIL = 'EMAIL',
}

export enum NotificationStatus {
    PENDING = 'PENDING',
    SENT = 'SENT',
    FAILED = 'FAILED',
    CANCELLED = 'CANCELLED',
}

export enum NotificationType {
    TRANSACTION = 'TRANSACTION',
    EMI_ALERT = 'EMI_ALERT',
    LOAN_QUERY = 'LOAN_QUERY',
    MANUAL = 'MANUAL',
    MONTHLY_SUMMARY = 'MONTHLY_SUMMARY',
}

@Entity('notification_logs')
export class NotificationLog {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'mbno', type: 'numeric', nullable: true })
    memberNo: string;

    @ManyToOne(() => Member, { nullable: true })
    @JoinColumn({ name: 'mbno' })
    member: Member;

    @Column({
        type: 'enum',
        enum: NotificationChannel,
        default: NotificationChannel.SMS,
    })
    channel: NotificationChannel;

    @Column({
        type: 'enum',
        enum: NotificationType,
        default: NotificationType.MANUAL,
    })
    type: NotificationType;

    @Column({ type: 'text' })
    message: string;

    @Column({ length: 100, nullable: true })
    recipient: string; // Phone number or email

    @Column({
        type: 'enum',
        enum: NotificationStatus,
        default: NotificationStatus.PENDING,
    })
    status: NotificationStatus;

    @Column({ type: 'text', nullable: true })
    errorMessage: string;

    @Column({ type: 'timestamp', nullable: true })
    sentAt: Date;

    @Column({ type: 'jsonb', nullable: true })
    metadata: any;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
