import { Entity, PrimaryGeneratedColumn, Column, OneToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../auth/entities/user.entity';

@Entity('user_preferences')
export class UserPreference {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    userId: number;

    @OneToOne(() => User)
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ default: 'light' })
    interfaceMode: 'light' | 'dark' | 'system';

    @Column({ default: '#6366f1' }) // Default Indigo
    accentColor: string;

    @Column({ type: 'float', default: 1.0 })
    fontScale: number;

    @Column({ type: 'float', default: 1.0 })
    density: number;

    @Column({ type: 'integer', default: 8 }) // Default 8px
    cornerRadius: number;

    // --- Added Missing Fields ---

    @Column({ default: 'Inter' })
    fontFamily: string;

    @Column({ default: 'solid' })
    backgroundType: 'image' | 'gradient' | 'solid';

    @Column({ default: '#ffffff' })
    backgroundColor1: string;

    @Column({ default: '#000000' })
    backgroundColor2: string;

    @Column({ type: 'text', nullable: true })
    backgroundImage: string;

    @Column({ default: '#1f2937' })
    textColor: string;

    @Column({ default: true })
    notifications: boolean;

    @Column({ default: true })
    syncAcrossWindows: boolean;

    @Column({ default: true })
    soundEffects: boolean;

    @Column({ default: true })
    inactivityLogout: boolean;

    @Column({ type: 'integer', default: 60 })
    inactivityTimeoutMinutes: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
