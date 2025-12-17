import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('transactions')
export class Transactions {
    @PrimaryColumn({ name: 'trans_no', type: 'int' })
    trans_no: number;

    @PrimaryColumn({ name: 'trans_date', type: 'timestamp' })
    trans_date: Date;

    @Column({ name: 'trans_type', type: 'varchar', length: 2 })
    trans_type: string;

    @Column({ name: 'mbno', type: 'numeric', precision: 18, scale: 0, default: 0 })
    mbno: number;

    @Column({ name: 'acc_no', type: 'numeric', precision: 18, scale: 0, default: 0 })
    acc_no: number;

    @Column({ name: 'acc_type', type: 'varchar', length: 4, default: 'OTH' })
    acc_type: string;

    @Column({ name: 'trans_amt', type: 'numeric', precision: 18, scale: 2, default: 0 })
    trans_amt: number;

    @Column({ name: 'receipt_vchr_no', type: 'varchar', length: 6, default: '' })
    receipt_vchr_no: string;

    @Column({ name: 'vchr_type', type: 'varchar', length: 2, default: 'R' })
    vchr_type: string;

    @Column({ name: 'modeofpay', type: 'varchar', length: 2, default: '' })
    modeofpay: string;

    @Column({ name: 'cheq_no', type: 'varchar', length: 10, default: '' })
    cheq_no: string;

    @Column({ name: 'cheq_amt', type: 'numeric', precision: 18, scale: 2, default: 0 })
    cheq_amt: number;

    @Column({ name: 'cheq_date', type: 'timestamp', nullable: true })
    cheq_date: Date;

    @Column({ name: 'bankname', type: 'varchar', length: 75, default: '' })
    bankname: string;

    @Column({ name: 'code', type: 'varchar', length: 5, default: '' })
    code: string;

    @Column({ name: 'narration', type: 'varchar', length: 100, default: '' })
    narration: string;
}
