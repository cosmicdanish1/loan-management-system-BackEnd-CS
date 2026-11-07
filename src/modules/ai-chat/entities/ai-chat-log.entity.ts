import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

// OK = answered, NOT_CONFIGURED = no provider keys, UNAVAILABLE = every provider failed,
// RATE_LIMITED = the employee hit the per-minute or daily cap (nothing was sent to a provider).
export type AiChatStatus = 'OK' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'RATE_LIMITED';

// One row per question asked to the assistant (ES-439): who asked, from which window, what came
// back, which provider answered and how long it took. Feeds the failure alert, the admin review
// list and the thumbs up/down feedback.
@Entity('ai_chat_logs')
export class AiChatLog {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'user_id', type: 'varchar', length: 50, nullable: true })
    userId: string | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    username: string | null;

    @Column({ type: 'varchar', length: 50, nullable: true })
    role: string | null;

    @Column({ type: 'varchar', length: 300, nullable: true })
    route: string | null;

    @Column({ type: 'text' })
    question: string;

    @Column({ type: 'text', nullable: true })
    answer: string | null;

    @Column({ type: 'varchar', length: 20, default: 'none' })
    provider: string;

    @Column({ type: 'varchar', length: 20, default: 'OK' })
    status: AiChatStatus;

    @Column({ name: 'failure_reason', type: 'varchar', length: 20, nullable: true })
    failureReason: string | null;

    @Column({ name: 'latency_ms', type: 'integer', default: 0 })
    latencyMs: number;

    // 1 = helpful, -1 = not helpful, null = no feedback given
    @Column({ type: 'smallint', nullable: true })
    feedback: number | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
