import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('fundsmaster')
export class FundsMaster {
    @PrimaryColumn({ name: 'mbno', type: 'numeric' })
    memberNo: number;

    @Column({ name: 'mdamt', type: 'numeric', nullable: true, default: 0 })
    monthlyContributionInstallment: number;

    @Column({ name: 'cdamt', type: 'numeric', nullable: true, default: 0 })
    compulsoryDepositInstallment: number;

    @Column({ name: 'shareamt', type: 'numeric', nullable: true, default: 0 })
    sharesInstallment: number;

    @Column({ name: 'mdopbal', type: 'numeric', nullable: true, default: 0 })
    monthlyContributionOpeningBalance: number;

    @Column({ name: 'shareopbal', type: 'numeric', nullable: true, default: 0 })
    sharesOpeningBalance: number;

    @Column({ name: 'cdopbal', type: 'numeric', nullable: true, default: 0 })
    compulsoryDepositOpeningBalance: number;

    @Column({ name: 'suspbal', type: 'decimal', nullable: true, default: 0 })
    suspenseBalance: number;

    @Column({ name: 'lnexecrec', type: 'decimal', nullable: true, default: 0 })
    loanExecutionReceipt: number;

    // Regular Loan (md1)
    @Column({ name: 'md1_opbal', type: 'numeric', nullable: true, default: 0 })
    rlnOpBal: number;

    @Column({ name: 'md1_amount', type: 'numeric', nullable: true, default: 0 })
    rlnAmt: number;

    // Emergency Loan (md2)
    @Column({ name: 'md2_opbal', type: 'numeric', nullable: true, default: 0 })
    elnOpBal: number;

    @Column({ name: 'md2_amount', type: 'numeric', nullable: true, default: 0 })
    elnAmt: number;
}
