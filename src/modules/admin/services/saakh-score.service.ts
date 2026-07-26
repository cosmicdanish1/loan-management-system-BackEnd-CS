import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface LoanDetail {
  loancaseno: number;
  loantype: string;
  loanAmt: number;
  balance: number;
  openbalance: number;
  instalAmt: number;
  noOfInstal: number;
  rate: number;
  penalrate: number;
  paymentDate: string;
  purpose: string;
  repaidPct: number;
}

export interface FactorScore {
  name: string;
  score: number;
  maxScore: number;
  description: string;
  status: 'good' | 'average' | 'poor';
}

export interface SaakhScoreResult {
  mbno: string;
  memberName: string;
  membershipDate: string | null;
  tenureYears: number;
  isActive: boolean;
  totalScore: number;
  tier: 'Platinum' | 'Gold' | 'Silver' | 'Bronze' | 'Critical';
  factors: FactorScore[];
  activeLoans: LoanDetail[];
  closedLoans: LoanDetail[];
  totalActiveLoans: number;
  totalOutstanding: number;
  totalOriginalLoanAmt: number;
  shareCapital: number;
  cdBalance: number;
  mdBalance: number;
  suspBal: number;
  eligibility: {
    eligible: 'YES' | 'CONDITIONAL' | 'NO';
    recommendedAmount: number;
    recommendedTenure: number;
    reason: string;
  };
  guarantorInfo: {
    isGuarantorForCount: number;
    guarantorLoansHealthy: boolean;
  };
  improvementTips: string[];
}

@Injectable()
export class SaakhScoreService {
  constructor(private readonly dataSource: DataSource) {}

  async calculateSaakhScore(mbno: string): Promise<SaakhScoreResult> {
    // ── 1. Member info ──────────────────────────────────────────────────────
    const memberRows = await this.dataSource.query(
      `SELECT mbno, f_name, m_name, l_name, memb_date, isactive
       FROM member_master WHERE CAST(mbno AS TEXT) = $1`,
      [mbno],
    );
    if (!memberRows.length) throw new NotFoundException(`Member ${mbno} not found`);
    const m = memberRows[0];

    const fullName = [m.f_name, m.m_name, m.l_name].filter(Boolean).join(' ').trim();
    const membershipDate: string | null = m.memb_date ? new Date(m.memb_date).toISOString().split('T')[0] : null;
    const tenureYears = membershipDate
      ? Math.floor((Date.now() - new Date(membershipDate).getTime()) / (1000 * 60 * 60 * 24 * 365))
      : 0;

    // ── 2. All loans ────────────────────────────────────────────────────────
    const loanRows = await this.dataSource.query(
      `SELECT loancaseno, loantype, loan_amt, balance, openbalance,
              instal_amt, no_of_instal, rate, penalrate, payment_date, purpose
       FROM loan_master WHERE CAST(mbno AS TEXT) = $1
       ORDER BY payment_date DESC`,
      [mbno],
    );

    const allLoans: LoanDetail[] = loanRows.map((r: any) => {
      const loanAmt = parseFloat(r.loan_amt) || 0;
      const balance = parseFloat(r.balance) || 0;
      const openbalance = parseFloat(r.openbalance) || loanAmt;
      const repaidPct = openbalance > 0 ? Math.round(((openbalance - balance) / openbalance) * 100) : 100;
      return {
        loancaseno: r.loancaseno,
        loantype: r.loantype || 'LOAN',
        loanAmt,
        balance,
        openbalance,
        instalAmt: parseFloat(r.instal_amt) || 0,
        noOfInstal: parseInt(r.no_of_instal) || 0,
        rate: parseFloat(r.rate) || 0,
        penalrate: parseFloat(r.penalrate) || 0,
        paymentDate: r.payment_date ? new Date(r.payment_date).toISOString().split('T')[0] : '',
        purpose: r.purpose || '',
        repaidPct,
      };
    });

    const activeLoans = allLoans.filter(l => l.balance > 0);
    const closedLoans = allLoans.filter(l => l.balance <= 0);
    const totalOutstanding = activeLoans.reduce((s, l) => s + l.balance, 0);
    const totalOriginalLoanAmt = activeLoans.reduce((s, l) => s + l.openbalance, 0);

    // ── 3. Funds master ─────────────────────────────────────────────────────
    const fundsRows = await this.dataSource.query(
      `SELECT shareamt, cdamt, mdamt, suspbal FROM fundsmaster WHERE CAST(mbno AS TEXT) = $1`,
      [mbno],
    );
    const funds = fundsRows[0] || {};
    const shareCapital = parseFloat(funds.shareamt) || 0;
    const cdBalance = parseFloat(funds.cdamt) || 0;
    const mdBalance = parseFloat(funds.mdamt) || 0;
    const suspBal = parseFloat(funds.suspbal) || 0;

    // ── 4. Guarantor info ───────────────────────────────────────────────────
    const guarantorRows = await this.dataSource.query(
      `SELECT sm.mbno as borrower_mbno,
              COALESCE(SUM(lm.balance::numeric), 0) as total_outstanding_for_borrower
       FROM suretymaster sm
       LEFT JOIN loan_master lm ON CAST(lm.mbno AS TEXT) = CAST(sm.mbno AS TEXT)
         AND lm.balance::numeric > 0
       WHERE CAST(sm.g1mbno AS TEXT) = $1 OR CAST(sm.g2mbno AS TEXT) = $1
       GROUP BY sm.mbno`,
      [mbno],
    );
    const isGuarantorForCount = guarantorRows.length;
    const guarantorLoansHealthy = guarantorRows.every(
      (g: any) => parseFloat(g.total_outstanding_for_borrower) === 0,
    );

    // ── 5. Score calculation ────────────────────────────────────────────────

    // Factor 1: Repayment punctuality (3.0 pts)
    // Heuristic: avg repaid% across all-time loans + suspense balance penalty
    let repaymentScore = 3.0;
    if (allLoans.length === 0) {
      repaymentScore = 2.0; // no loan history → neutral-low
    } else {
      const avgRepaid = allLoans.reduce((s, l) => s + l.repaidPct, 0) / allLoans.length;
      if (avgRepaid >= 90) repaymentScore = 3.0;
      else if (avgRepaid >= 70) repaymentScore = 2.5;
      else if (avgRepaid >= 50) repaymentScore = 2.0;
      else if (avgRepaid >= 30) repaymentScore = 1.2;
      else repaymentScore = 0.5;
    }
    if (suspBal > 0) repaymentScore = Math.max(0, repaymentScore - 0.5);
    repaymentScore = Math.min(3.0, Math.max(0, repaymentScore));

    // Factor 2: Penalty history (2.0 pts)
    const loansWithPenalty = activeLoans.filter(l => l.penalrate > 0).length;
    let penaltyScore = 2.0 - loansWithPenalty * 0.5;
    if (suspBal > 0) penaltyScore -= 0.3;
    penaltyScore = Math.min(2.0, Math.max(0, penaltyScore));

    // Factor 3: Active loan load (1.5 pts)
    let loanLoadScore: number;
    if (activeLoans.length === 0) loanLoadScore = 1.5;
    else if (activeLoans.length === 1) loanLoadScore = 1.2;
    else if (activeLoans.length === 2) loanLoadScore = 0.8;
    else loanLoadScore = 0.3;

    // Factor 4: Savings + share capital (1.5 pts)
    // Normalize: 0 → 0, ₹1L → 0.5, ₹3L → 1.0, ₹5L+ → 1.5
    const savingsTotal = shareCapital + cdBalance;
    let savingsScore: number;
    if (savingsTotal >= 500000) savingsScore = 1.5;
    else if (savingsTotal >= 300000) savingsScore = 1.2;
    else if (savingsTotal >= 100000) savingsScore = 0.9;
    else if (savingsTotal >= 50000) savingsScore = 0.6;
    else if (savingsTotal >= 10000) savingsScore = 0.3;
    else savingsScore = 0.1;

    // Factor 5: Membership tenure (1.0 pt)
    let tenureScore: number;
    if (tenureYears >= 10) tenureScore = 1.0;
    else if (tenureYears >= 5) tenureScore = 0.8;
    else if (tenureYears >= 3) tenureScore = 0.6;
    else if (tenureYears >= 1) tenureScore = 0.4;
    else tenureScore = 0.2;

    // Factor 6: Guarantor reliability (1.0 pt)
    let guarantorScore: number;
    if (isGuarantorForCount === 0) guarantorScore = 0.7; // never been guarantor → neutral
    else if (guarantorLoansHealthy) guarantorScore = 1.0; // all clear
    else guarantorScore = 0.3; // some guarantor loans still active

    const totalScore = parseFloat(
      (repaymentScore + penaltyScore + loanLoadScore + savingsScore + tenureScore + guarantorScore).toFixed(1),
    );

    // ── 6. Tier ─────────────────────────────────────────────────────────────
    let tier: SaakhScoreResult['tier'];
    if (totalScore >= 9) tier = 'Platinum';
    else if (totalScore >= 7) tier = 'Gold';
    else if (totalScore >= 5) tier = 'Silver';
    else if (totalScore >= 3) tier = 'Bronze';
    else tier = 'Critical';

    // ── 7. Factors breakdown ────────────────────────────────────────────────
    const factors: FactorScore[] = [
      {
        name: 'Repayment Punctuality',
        score: repaymentScore,
        maxScore: 3.0,
        description: allLoans.length
          ? `Avg ${Math.round(allLoans.reduce((s, l) => s + l.repaidPct, 0) / allLoans.length)}% repaid across ${allLoans.length} loan(s)`
          : 'No loan history on record',
        status: repaymentScore >= 2.5 ? 'good' : repaymentScore >= 1.5 ? 'average' : 'poor',
      },
      {
        name: 'Penalty History',
        score: penaltyScore,
        maxScore: 2.0,
        description: loansWithPenalty === 0
          ? 'No penalty charges on active loans'
          : `${loansWithPenalty} active loan(s) carry penalty rate`,
        status: penaltyScore >= 1.8 ? 'good' : penaltyScore >= 1.0 ? 'average' : 'poor',
      },
      {
        name: 'Active Loan Load',
        score: loanLoadScore,
        maxScore: 1.5,
        description: activeLoans.length === 0
          ? 'No outstanding loans — excellent'
          : `${activeLoans.length} active loan(s) — ₹${totalOutstanding.toLocaleString('en-IN')} outstanding`,
        status: loanLoadScore >= 1.2 ? 'good' : loanLoadScore >= 0.7 ? 'average' : 'poor',
      },
      {
        name: 'Savings & Share Capital',
        score: savingsScore,
        maxScore: 1.5,
        description: `Share: ₹${shareCapital.toLocaleString('en-IN')} · CD: ₹${cdBalance.toLocaleString('en-IN')}`,
        status: savingsScore >= 1.2 ? 'good' : savingsScore >= 0.6 ? 'average' : 'poor',
      },
      {
        name: 'Membership Tenure',
        score: tenureScore,
        maxScore: 1.0,
        description: `${tenureYears} year${tenureYears !== 1 ? 's' : ''} as member${membershipDate ? ` since ${membershipDate}` : ''}`,
        status: tenureScore >= 0.8 ? 'good' : tenureScore >= 0.5 ? 'average' : 'poor',
      },
      {
        name: 'Guarantor Reliability',
        score: guarantorScore,
        maxScore: 1.0,
        description: isGuarantorForCount === 0
          ? 'Not a guarantor for any member'
          : `Guarantor for ${isGuarantorForCount} member(s) — ${guarantorLoansHealthy ? 'all loans healthy' : 'some loans still active'}`,
        status: guarantorScore >= 0.8 ? 'good' : guarantorScore >= 0.5 ? 'average' : 'poor',
      },
    ];

    // ── 8. Eligibility ──────────────────────────────────────────────────────
    let eligible: 'YES' | 'CONDITIONAL' | 'NO';
    let recommendedAmount = 0;
    let recommendedTenure = 0;
    let reason = '';

    if (totalScore >= 7) {
      eligible = 'YES';
      // Scale recommendation with score: higher score → bigger loan
      const baseAmt = savingsTotal * 3 + shareCapital;
      recommendedAmount = Math.round(Math.min(baseAmt * (totalScore / 10), 1000000) / 1000) * 1000;
      recommendedTenure = totalScore >= 9 ? 60 : totalScore >= 8 ? 48 : 36;
      reason = 'Strong repayment history and low loan burden.';
    } else if (totalScore >= 5) {
      eligible = 'CONDITIONAL';
      recommendedAmount = Math.round(Math.min(savingsTotal, 300000) / 1000) * 1000;
      recommendedTenure = 24;
      reason = 'Eligible subject to committee review and guarantor.';
    } else {
      eligible = 'NO';
      reason = 'Score too low — clear existing dues and build repayment record first.';
    }

    // ── 9. Improvement tips ─────────────────────────────────────────────────
    const improvementTips: string[] = [];
    if (loansWithPenalty > 0) improvementTips.push('Clear penalty dues on active loans to boost Penalty History score by up to 2 pts.');
    if (savingsTotal < 50000) improvementTips.push('Increase CD/Share deposits — higher savings capital raises your eligibility limit.');
    if (suspBal > 0) improvementTips.push(`Resolve suspense balance of ₹${suspBal.toLocaleString('en-IN')} — it is pulling down your repayment score.`);
    if (activeLoans.length >= 3) improvementTips.push('Close at least one active loan before applying for a new one — loan load is high.');
    if (tenureYears < 2) improvementTips.push('Maintain your membership — score improves automatically with tenure milestones at 3, 5, and 10 years.');
    if (improvementTips.length === 0) improvementTips.push('Excellent profile! Maintain consistent repayments to stay at this tier.');

    return {
      mbno,
      memberName: fullName,
      membershipDate,
      tenureYears,
      isActive: m.isactive === 'Y' || m.isactive === '1' || m.isactive === true,
      totalScore,
      tier,
      factors,
      activeLoans,
      closedLoans,
      totalActiveLoans: activeLoans.length,
      totalOutstanding,
      totalOriginalLoanAmt,
      shareCapital,
      cdBalance,
      mdBalance,
      suspBal,
      eligibility: { eligible, recommendedAmount, recommendedTenure, reason },
      guarantorInfo: { isGuarantorForCount, guarantorLoansHealthy },
      improvementTips,
    };
  }
}
