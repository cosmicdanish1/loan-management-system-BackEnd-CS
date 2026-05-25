import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('fdmaster')
export class FdAccount {
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

    @Column({ name: 'certno', length: 10, nullable: true })
    certificateNo: string;

    @Column({ name: 'depunit', type: 'int', nullable: true })
    depositUnit: number;

    @Column({ name: 'depperiod', type: 'numeric', nullable: true })
    depositPeriod: number;

    @Column({ name: 'rate', type: 'numeric', nullable: true })
    rate: number;

    @Column({ name: 'depdate', type: 'timestamp', nullable: true })
    depositDate: Date;

    @Column({ name: 'matdate', type: 'timestamp', nullable: true })
    maturityDate: Date;

    @Column({ name: 'fdamount', type: 'numeric', nullable: true })
    fdAmount: number;

    @Column({ name: 'matamount', type: 'numeric', nullable: true })
    maturityAmount: number;

    @Column({ name: 'interestbalance', type: 'numeric', nullable: true })
    interestBalance: number;

    @Column({ name: 'interestamount', type: 'numeric', nullable: true })
    interestAmount: number;

    @Column({ name: 'lastintpaydate', type: 'timestamp', nullable: true })
    lastIntPaymentDate: Date;

    @Column({ name: 'intpaid', type: 'numeric', nullable: true })
    interestPaid: number;

    @Column({ name: 'status', length: 1, nullable: true })
    status: string;

    @Column({ name: 'nominee', length: 80, nullable: true })
    nominee: string;

    @Column({ name: 'nage', length: 6, nullable: true })
    nomineeAge: string;

    @Column({ name: 'naddr', length: 100, nullable: true })
    nomineeAddress: string;

    @Column({ name: 'nrelation', length: 25, nullable: true })
    nomineeRelation: string;

    @Column({ name: 'interestpayamentmode', type: 'int', nullable: true })
    modeOfPayment: number;

    // BUG FIX: missing column — without this, WHERE fdrdflag='F' is impossible via TypeORM.
    // 'F' = FD account, 'R' = RD account. All FD queries MUST filter by this.
    @Column({ name: 'fdrdflag', length: 1, nullable: true })
    fdrdflag: string;
}
