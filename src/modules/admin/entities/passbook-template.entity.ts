import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, OneToMany, OneToOne, JoinColumn } from 'typeorm';
import { PassbookField } from './passbook-field.entity';
import { PassbookPagePosition } from './passbook-page-position.entity';

@Entity('passbook_templates')
export class PassbookTemplate {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'template_name', length: 100, unique: true })
    templateName: string;

    @Column({ name: 'account_type', length: 100 })
    accountType: string;

    @Column({ name: 'is_default', default: false })
    isDefault: boolean;

    @OneToOne(() => PassbookPagePosition, (pos) => pos.template, { cascade: true, eager: true })
    pageSettings: PassbookPagePosition;

    @OneToMany(() => PassbookField, (field) => field.template, { cascade: true, eager: true })
    fields: PassbookField[];

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
