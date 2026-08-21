import { Entity, Column, PrimaryColumn } from 'typeorm';

// Canonical entity for demand_master — this is the ONE definition that should
// be imported everywhere (loan module and transaction module both register
// this same class). A second, divergent DemandMaster entity used to live in
// loan/entities/demand-master.entity.ts with a different assumed primary key
// (composite mbno+month+year) while this one used dmnd_srno; that file now
// just re-exports this one.
//
// Note on `id` (dmnd_srno): the live DB has NO unique constraint on this
// column — the only real unique/composite key is (mbno, demand_for_month,
// demand_for_year). A batch of legacy Nov-2019 rows all share dmnd_srno = 0.
// Code that looks up a row by `id` (see ShortRecoveryService.adjust) can
// match the wrong row for that legacy batch — tracked separately, don't rely
// on `id` alone for anything touching pre-2020 demand rows.
@Entity('demand_master')
export class DemandMaster {
    @PrimaryColumn({ name: 'dmnd_srno' })
    id: number;

    @Column({ name: 'demand_for_month' })
    month: number;

    @Column({ name: 'demand_for_year' })
    year: number;

    @Column({ name: 'mbno', type: 'numeric' })
    memberNo: number;

    @Column({ name: 'demand_posted', type: 'varchar', length: 1, nullable: true })
    demandPosted: string;

    @Column({ name: 'officeno', type: 'integer', nullable: true })
    officeNo: number;

    @Column({ name: 'balance_for_month', type: 'numeric' })
    balance: number;

    @Column({ name: 'totaldemand', type: 'numeric' })
    totalDemand: number;

    @Column({ name: 'rln_amount', type: 'numeric', nullable: true })
    rlnAmount: number;

    @Column({ name: 'rln_installment_amount', type: 'numeric', nullable: true })
    rlnInstallmentAmount: number;

    @Column({ name: 'rln_interest', type: 'numeric', nullable: true })
    rlnInterest: number;

    @Column({ name: 'eln_amount', type: 'numeric', nullable: true })
    elnAmount: number;

    @Column({ name: 'eln_installment_amount', type: 'numeric', nullable: true })
    elnInstallmentAmount: number;

    @Column({ name: 'eln_interest', type: 'numeric', nullable: true })
    elnInterest: number;

    @Column({ name: 'aln_amount', type: 'numeric', nullable: true })
    alnAmount: number;

    @Column({ name: 'aln_installment_amount', type: 'numeric', nullable: true })
    alnInstallmentAmount: number;

    @Column({ name: 'aln_interest', type: 'numeric', nullable: true })
    alnInterest: number;

    @Column({ name: 'mln_amount', type: 'numeric', nullable: true })
    mlnAmount: number;

    @Column({ name: 'mln_installment_amount', type: 'numeric', nullable: true })
    mlnInstallmentAmount: number;

    @Column({ name: 'mln_interest', type: 'numeric', nullable: true })
    mlnInterest: number;

    @Column({ name: 'rd_amount', type: 'numeric', nullable: true })
    rdAmount: number;

    @Column({ name: 'md_amount', type: 'numeric', nullable: true })
    mdAmount: number;

    @Column({ name: 'cd_amount', type: 'numeric', nullable: true })
    cdAmount: number;

    @Column({ name: 'shr_amount', type: 'numeric', nullable: true })
    shrAmount: number;

    @Column({ name: 'receipt_vchr_no', type: 'varchar', length: 6, nullable: true })
    receiptVoucherNo: string;

    @Column({ name: 'dmnd_gnrt_date', type: 'timestamp', nullable: true })
    demandGenerateDate: Date;

    @Column({ name: 'dmnd_post_date', type: 'timestamp', nullable: true })
    demandPostDate: Date;
}
