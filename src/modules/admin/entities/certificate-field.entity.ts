import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { CertificateTemplate } from './certificate-template.entity';

@Entity('certificate_fields')
export class CertificateField {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'template_id' })
    templateId: number;

    @ManyToOne(() => CertificateTemplate, (template) => template.fields, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'template_id' })
    template: CertificateTemplate;

    @Column({ length: 50 })
    label: string;

    @Column({ name: 'data_key', length: 50 })
    dataKey: string;

    @Column({ name: 'row_pos', type: 'int' })
    rowPos: number;

    @Column({ name: 'col_pos', type: 'int' })
    colPos: number;

    @Column({ type: 'int', default: 0 })
    length: number;

    @Column({ name: 'transform_mode', length: 20, default: 'NONE' })
    transformMode: string;

    @Column({ name: 'is_visible', default: true })
    isVisible: boolean;
}
