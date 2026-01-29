import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { CertificateField } from './certificate-field.entity';

@Entity('certificate_templates')
export class CertificateTemplate {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'template_name', length: 50, unique: true })
    templateName: string;

    @Column({ name: 'account_type', length: 50 })
    accountType: string;

    @Column({ name: 'is_default', default: false })
    isDefault: boolean;

    @OneToMany(() => CertificateField, (field) => field.template, { cascade: true })
    fields: CertificateField[];

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
