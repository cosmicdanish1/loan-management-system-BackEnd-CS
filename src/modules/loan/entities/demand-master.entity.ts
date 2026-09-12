import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('demand_master')
export class DemandMaster {
  @PrimaryColumn({ name: 'demand_for_year', type: 'integer' })
  demandForYear: number;

  @PrimaryColumn({ name: 'demand_for_month', type: 'smallint' })
  demandForMonth: number;

  @PrimaryColumn({ name: 'mbno', type: 'numeric', precision: 18, scale: 0 })
  mbno: string;

  @Column({ name: 'demand_posted', type: 'varchar', length: 1 })
  demandPosted: string;

  @Column({ name: 'rln_amount', type: 'numeric', precision: 18, scale: 2 })
  rlnAmount: number;

  @Column({ name: 'eln_amount', type: 'numeric', precision: 18, scale: 2 })
  elnAmount: number;

  @Column({ name: 'aln_amount', type: 'numeric', precision: 18, scale: 2 })
  alnAmount: number;

  @Column({ name: 'mln_amount', type: 'numeric', precision: 18, scale: 2 })
  mlnAmount: number;

  @Column({ name: 'rln_installment_amount', type: 'numeric', precision: 18, scale: 2 })
  rlnInstallmentAmount: number;

  @Column({ name: 'rln_interest', type: 'numeric', precision: 18, scale: 2 })
  rlnInterest: number;

  @Column({ name: 'eln_installment_amount', type: 'numeric', precision: 18, scale: 2 })
  elnInstallmentAmount: number;

  @Column({ name: 'eln_interest', type: 'numeric', precision: 18, scale: 2 })
  elnInterest: number;

  @Column({ name: 'aln_installment_amount', type: 'numeric', precision: 18, scale: 2 })
  alnInstallmentAmount: number;

  @Column({ name: 'aln_interest', type: 'numeric', precision: 18, scale: 2 })
  alnInterest: number;

  @Column({ name: 'mln_installment_amount', type: 'numeric', precision: 18, scale: 2 })
  mlnInstallmentAmount: number;

  @Column({ name: 'mln_interest', type: 'numeric', precision: 18, scale: 2 })
  mlnInterest: number;

  @Column({ name: 'rd_amount', type: 'numeric', precision: 18, scale: 2 })
  rdAmount: number;

  @Column({ name: 'md_amount', type: 'numeric', precision: 18, scale: 2 })
  mdAmount: number;

  @Column({ name: 'cd_amount', type: 'numeric', precision: 18, scale: 2 })
  cdAmount: number;

  @Column({ name: 'shr_amount', type: 'numeric', precision: 18, scale: 2 })
  shrAmount: number;

  @Column({ name: 'bankcharge', type: 'numeric', precision: 18, scale: 2 })
  bankCharge: number;

  @Column({ name: 'sd', type: 'varchar', length: 1 })
  sd: string;

  @Column({ name: 'balance_for_month', type: 'numeric', precision: 18, scale: 2 })
  balanceForMonth: number;

  @Column({ name: 'dmnd_gnrt_date', type: 'timestamp', nullable: true })
  demandGenerateDate: Date;

  @Column({ name: 'officeno', type: 'integer' })
  officeNo: number;

  @Column({ name: 'totaldemand', type: 'numeric', precision: 18, scale: 2 })
  totalDemand: number;

  @Column({ name: 'others', type: 'numeric', precision: 18, scale: 2 })
  others: number;

  @Column({ name: 'rdbalance', type: 'numeric', precision: 18, scale: 2 })
  rdBalance: number;

  @Column({ name: 'mdbalance', type: 'numeric', precision: 18, scale: 2 })
  mdBalance: number;

  @Column({ name: 'cdbalance', type: 'numeric', precision: 18, scale: 2 })
  cdBalance: number;

  @Column({ name: 'shrbalance', type: 'numeric', precision: 18, scale: 2 })
  shrBalance: number;

  @Column({ name: 'receipt_vchr_no', type: 'varchar', length: 6 })
  receiptVoucherNo: string;

  @Column({ name: 'dmnd_post_date', type: 'timestamp', nullable: true })
  demandPostDate: Date;
}