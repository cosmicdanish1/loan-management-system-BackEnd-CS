import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('sbmaster')
export class SbAccount {
    @PrimaryColumn({ name: 'account_no', length: 20 })
    accountNo: string;

    @Column({ name: 'member_no', length: 20 })
    memberNo: string;

    @Column({ name: 'opening_date', type: 'date', nullable: true })
    openingDate: Date;

    @Column({ name: 'opening_balance', type: 'decimal', precision: 18, scale: 2, default: 0 })
    openingBalance: number;

    @Column({ name: 'current_balance', type: 'decimal', precision: 18, scale: 2, default: 0 })
    currentBalance: number;

    @Column({ name: 'ledger_group', length: 50, nullable: true })
    ledgerGroup: string;

    @Column({ name: 'instructions', type: 'text', nullable: true })
    specialInstructions: string;

    @Column({ name: 'status', length: 20, default: 'Active' })
    status: string;

    // Nominee Details (Flattened as per plan/typical DB structure for this legacy-style app)
    @Column({ name: 'nominee_name', length: 100, nullable: true })
    nomineeName: string;

    @Column({ name: 'nominee_age', length: 10, nullable: true })
    nomineeAge: string;

    @Column({ name: 'nominee_address', length: 255, nullable: true })
    nomineeAddress: string;

    @Column({ name: 'nominee_relation', length: 50, nullable: true })
    nomineeRelation: string;
}
