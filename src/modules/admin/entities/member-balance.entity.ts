import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('member_balances')
export class MemberBalance {
    @PrimaryColumn({ name: 'mbno', type: 'float8' })
    memberNo: number;

    @Column({ name: 'member_name', length: 255, nullable: true })
    memberName: string;

    @Column({ name: 'shares', type: 'float8', nullable: true, default: 0 })
    shares: number;

    @Column({ name: 'rd_amt', type: 'float8', nullable: true, default: 0 })
    rdAmount: number;

    @Column({ name: 'compulsory_deposit', type: 'float8', nullable: true, default: 0 })
    savingAmount: number;

    @Column({ name: 'regularloan', type: 'float8', nullable: true, default: 0 })
    loanBalance: number;

    @Column({ name: 'emergency_loan_balance', type: 'float8', nullable: true, default: 0 })
    emergencyLoanBalance: number;

    @Column({ name: 'frsbalance', type: 'float8', nullable: true, default: 0 })
    frsBalance: number;
}
