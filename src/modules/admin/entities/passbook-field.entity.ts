import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { PassbookTemplate } from './passbook-template.entity';

@Entity('passbook_fields')
export class PassbookField {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    name: string;

    @Column({ name: 'row_pos' })
    rowPos: number;

    @Column({ name: 'col_pos' })
    colPos: number;

    @Column({ name: 'is_visible', default: true })
    isVisible: boolean;

    @Column({ name: 'is_label_visible', default: true })
    isLabelVisible: boolean;

    @Column({ name: 'field_type', default: 'TRANSACTION' }) // MANIFEST or TRANSACTION
    fieldType: string;

    @Column({ name: 'template_id' })
    templateId: number;

    @ManyToOne(() => PassbookTemplate, (template) => template.fields, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'template_id' })
    template: PassbookTemplate;
}
