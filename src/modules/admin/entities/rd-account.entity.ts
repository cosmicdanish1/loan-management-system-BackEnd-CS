import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('fdmaster')
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

    @Column({ name: 'depdate', type: 'timestamp', nullable: true })
    depositDate: Date;

    @Column({ name: 'fdamount', type: 'numeric', nullable: true })
    amount: number;

    @Column({ name: 'rate', type: 'numeric', nullable: true })
    rate: number;

    @Column({ name: 'depperiod', type: 'numeric', nullable: true })
    depositPeriod: number;

    @Column({ name: 'depunit', type: 'integer', nullable: true })
    depositUnit: number;

    @Column({ name: 'matdate', type: 'timestamp', nullable: true })
    maturityDate: Date;

    @Column({ name: 'matamount', type: 'numeric', nullable: true })
    maturityAmount: number;

    @Column({ name: 'status', length: 20, nullable: true })
    status: string;

    @Column({ name: 'nominee', length: 100, nullable: true })
    nominee: string;

    @Column({ name: 'nage', length: 10, nullable: true })
    nomineeAge: string;

    @Column({ name: 'naddr', length: 100, nullable: true })
    nomineeAddress: string;

    @Column({ name: 'nrelation', length: 50, nullable: true })
    nomineeRelation: string;

    @Column({ name: 'remarks', length: 200, nullable: true })
    specialInstructions: string;

    @Column({ name: 'fdrdflag', length: 5, nullable: true, default: 'R' })
    fdrdFlag: string;

    @Column({ name: 'interestpayamentmode', type: 'integer', default: 1 })
    interestPaymentMode: number;
}
