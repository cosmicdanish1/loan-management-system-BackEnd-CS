import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('system_settings')
export class SystemSetting {
    @PrimaryColumn()
    @ApiProperty({ description: 'Setting key identifier' })
    key: string;

    @Column({ type: 'text', nullable: true })
    @ApiProperty({ description: 'Setting value' })
    value: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
