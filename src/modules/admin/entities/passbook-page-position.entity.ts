import { Entity, Column, PrimaryGeneratedColumn, OneToOne, JoinColumn } from 'typeorm';
import { PassbookTemplate } from './passbook-template.entity';

@Entity('passbook_page_positions')
export class PassbookPagePosition {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'bank_format', length: 50, nullable: true })
    bankFormat: string;

    @Column({ name: 'total_pages', default: 0 })
    totalPages: number;

    @Column({ name: 'lines_per_page', default: 0 })
    linesPerPage: number;

    @Column({ name: 'line_start_number', default: 1 })
    lineStartNumber: number;

    @Column({ name: 'increment_level', default: 1 })
    incrementLevel: number;

    @Column({ name: 'template_id' })
    templateId: number;

    @OneToOne(() => PassbookTemplate, (template) => template.pageSettings, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'template_id' })
    template: PassbookTemplate;
}
