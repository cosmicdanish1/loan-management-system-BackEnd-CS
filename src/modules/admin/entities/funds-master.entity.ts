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

    // Existing legacy columns kept for completeness
    @Column({ name: 'lnexecrec', type: 'decimal', nullable: true, default: 0 })
    loanExecutionReceipt: number;
}
