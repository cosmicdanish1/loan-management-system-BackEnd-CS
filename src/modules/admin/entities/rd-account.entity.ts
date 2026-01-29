import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('rdmaster')
export class RdAccount {
    @PrimaryColumn({ name: 'account_number', type: 'numeric' })
    accountNumber: number;

    @Column({ name: 'mbno', type: 'numeric', nullable: true })
    memberNo: number;

    @Column({ name: 'prefix', length: 5, nullable: true })
    prefix: string;

    @Column({ name: 'f_name', length: 50, nullable: true })
    firstName: string;

    @Column({ name: 'm_name', length: 50, nullable: true })
    middleName: string;

    @Column({ name: 'l_name', length: 50, nullable: true })
    lastName: string;

    @Column({ name: 'deposit_date', type: 'date', nullable: true })
    depositDate: Date;

    @Column({ name: 'amount', type: 'numeric', nullable: true })
    amount: number;

    @Column({ name: 'rate', type: 'numeric', nullable: true })
    rate: number;

    @Column({ name: 'dep_period', type: 'numeric', nullable: true })
    depositPeriod: number;

    @Column({ name: 'dep_unit', length: 10, nullable: true })
    depositUnit: string;

    @Column({ name: 'maturity_date', type: 'date', nullable: true })
    maturityDate: Date;

    @Column({ name: 'maturity_amount', type: 'numeric', nullable: true })
    maturityAmount: number;

    @Column({ name: 'status', length: 20, default: 'Active' })
    status: string;

    @Column({ name: 'nominee', length: 100, nullable: true })
    nominee: string;

    @Column({ name: 'nominee_age', length: 10, nullable: true })
    nomineeAge: string;

    @Column({ name: 'nominee_relation', length: 50, nullable: true })
    nomineeRelation: string;

    @Column({ name: 'special_instructions', type: 'text', nullable: true })
    specialInstructions: string;
}
