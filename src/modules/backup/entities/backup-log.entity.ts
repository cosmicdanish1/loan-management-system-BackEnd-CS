import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('backup_log')
export class BackupLog {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'file_name' })
    fileName: string;

    @Column({ name: 'file_path' })
    filePath: string;

    @Column({ name: 'file_size', type: 'bigint' })
    fileSize: string; // TypeORM maps bigint to string in JS

    @Column({ name: 'backup_type' })
    backupType: 'full' | 'schema' | 'data';

    @Column({ name: 'status' })
    status: 'success' | 'failed' | 'restored';

    @Column({ name: 'duration_ms', type: 'int' })
    durationMs: number;

    @Column({ name: 'error_message', nullable: true, type: 'text' })
    errorMessage: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @Column({ name: 'created_by', nullable: true })
    createdBy: string;
}
