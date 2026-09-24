// Comprehensive live RD scenario test — boots the real NestJS app context
// (no HTTP listener) and drives the ACTUAL RD services against the real
// Postgres DB with synthetic members, exactly like _verify-rd-disabled.ts
// does. Prints a scenario-by-scenario report to stdout.
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MemberCrudService } from '../modules/member/services-v2/member-crud.service';
import { RdMemberConfigService } from '../modules/rd/services/rd-member-config.service';
import { RdRepaymentService } from '../modules/rd/services/rd-repayment.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';
import { RdPatternEligibilityService } from '../modules/rd/services/rd-pattern-eligibility.service';
import { RdInterestCalculationService } from '../modules/rd/services/rd-interest-calculation.service';
import { RdFinancialYearClosingService } from '../modules/rd/services/rd-financial-year-closing.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { fullYearInstallmentInterest } from '../modules/rd/rd-interest-chart';

const YEARCODE = 1; // FY 2026-04-01 .. 2027-03-31
const RATE = 7; // RULE_RD_OPENING_BALANCE_RATE default

function line(s = '') { console.log(s); }
function header(s: string) { line('\n' + '='.repeat(90)); line(s); line('='.repeat(90)); }

async function makeMember(memberCrud: MemberCrudService, tag: string) {
    const m = await memberCrud.saveMemberMaster({
        mbno: 'auto', f_name: 'RDTEST', l_name: tag,
        officeno: 2, branchmsno: '1-POWERHOUSE-POWERHOUSE-94',
        isactive: 'Y', memb_date: new Date('2026-04-01'),
    });
    return String(m.mbno);
}

async function main() {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const memberCrud = app.get(MemberCrudService);
        const memberConfig = app.get(RdMemberConfigService);
        const repayment = app.get(RdRepaymentService);
        const balanceEvents = app.get(RdBalanceEventsService);
        const patternElig = app.get(RdPatternEligibilityService);
        const interestCalc = app.get(RdInterestCalculationService);
        const fyClosing = app.get(RdFinancialYearClosingService);
        const loanEligibility = app.get(LoanEligibilityService);
        const ds = app.get(DataSource);

        // ============================================================
        // SCENARIO 1: Fully regular RD — all 12 installments paid on time
        // ============================================================
        header('SCENARIO 1: All 12 RD installments paid on time — expected balance & interest at FY close');
        const m1 = await makeMember(memberCrud, 'REGULAR');
        await memberConfig.setMonthlyAmount(m1, YEARCODE, 500, 'tester');
        for (let i = 0; i < 12; i++) {
            const month = ((3 + i) % 12) + 1; // Apr=4..Mar=3, sequence 4,5,...12,1,2,3
            const year = month >= 4 ? 2026 : 2027;
            const dueDate = new Date(year, month - 1, 5);
            await repayment.recordPayment(m1, YEARCODE, month, year, 500, dueDate, 'on-time', 'tester');
        }
        const pattern1 = await patternElig.evaluateMember(m1, YEARCODE);
        const interest1 = await interestCalc.previewTotalInterest(m1, YEARCODE);
        const expectedFullInterest = fullYearInstallmentInterest(500, RATE);
        line(`Member ${m1}: pattern=${pattern1.detectedPattern}, autoEligible=${pattern1.autoEligibleFullInterest}`);
        line(`Installment interest (calculated): ₹${interest1.installmentInterest.totalInterest} | Formula full-year expectation: ₹${expectedFullInterest}`);
        line(`MATCH: ${interest1.installmentInterest.totalInterest === expectedFullInterest ? 'YES' : 'MISMATCH!!'}`);
        line(`Opening-balance interest (no opening balance/events): ₹${interest1.openingBalanceInterest.totalInterest}`);
        const close1 = await fyClosing.closeMemberYear(m1, YEARCODE, 'tester');
        line(`FY CLOSE -> total interest credited: ₹${close1.totalInterestCredited}, closing balance: ₹${close1.closingBalance} (12x500=6000 principal + interest)`);
        line(`Expected closing balance = 6000 + ${close1.totalInterestCredited} = ${6000 + close1.totalInterestCredited}; actual = ${close1.closingBalance}`);
        line(`Rolled forward to yearcode ${close1.nextYearcode}: ${close1.rolledForward}`);

        // ============================================================
        // SCENARIO 2: Opening balance + mid-year withdrawal
        // ============================================================
        header('SCENARIO 2: Member with an opening balance, then a mid-year withdrawal — opening-balance interest split');
        const m2 = await makeMember(memberCrud, 'WITHDRAW');
        await balanceEvents.recordOpeningBalance(m2, YEARCODE, 12000, new Date(2026, 3, 1), 'tester'); // Apr 1
        const beforeWithdraw = await balanceEvents.getCurrentBalance(m2, YEARCODE);
        line(`Opening balance recorded: ₹${beforeWithdraw}`);
        const withdrawResult = await balanceEvents.recordWithdrawal(m2, YEARCODE, 5000, new Date(2026, 8, 15), 'tester', 'Member need'); // Sep 15
        line(`Withdrew ₹5000 on 2026-09-15 -> fromOpeningPot=${withdrawResult.fromOpeningPot}, remainingTotalHoldings=${withdrawResult.remainingTotalHoldings}`);
        const ob2 = await interestCalc.calculateOpeningBalanceInterest(m2, YEARCODE);
        line(`Opening-balance interest periods:`);
        ob2.periods.forEach(p => line(`  ${p.fromDate.toISOString().slice(0,10)} -> ${p.toDate.toISOString().slice(0,10)} @ balance ₹${p.balance} for ${p.monthsHeld} months = ₹${p.interest}`));
        line(`Total opening-balance interest: ₹${ob2.totalInterest}`);
        // Manual expectation: Apr-Aug (5 months) @ 12000, Sep-Mar (7 months) @ 7000
        const expected2 = Math.round((12000 * 0.07 * 5/12 + 7000 * 0.07 * 7/12) * 100) / 100;
        line(`Manual expectation (5mo@12000 + 7mo@7000 at 7%): ₹${expected2} -> MATCH: ${ob2.totalInterest === expected2 ? 'YES' : 'MISMATCH!!'}`);

        // Try withdrawing below minimum balance
        try {
            await balanceEvents.recordWithdrawal(m2, YEARCODE, 6500, new Date(2026, 9, 1), 'tester', 'Over-withdraw attempt');
            line('!!! UNEXPECTED: withdrawal below minimum balance was allowed');
        } catch (e: any) {
            line(`Withdrawal below min-balance correctly REJECTED: ${e.message}`);
        }

        // ============================================================
        // SCENARIO 3: Loan-linked RD addition (5% shortfall added at disbursement time)
        // ============================================================
        header('SCENARIO 3: Loan-linked RD addition — delayed one month per spec');
        const m3 = await makeMember(memberCrud, 'LOANADD');
        await balanceEvents.recordOpeningBalance(m3, YEARCODE, 3000, new Date(2026, 3, 1), 'tester'); // Apr 1
        await balanceEvents.recordLoanAddition(m3, YEARCODE, 4000, new Date(2026, 5, 10), 'Loan shortfall addition', 'tester'); // Jun 10
        const ob3 = await interestCalc.calculateOpeningBalanceInterest(m3, YEARCODE);
        line(`Opening-balance interest periods (opening ₹3000 Apr1, +₹4000 loan addition Jun10):`);
        ob3.periods.forEach(p => line(`  ${p.fromDate.toISOString().slice(0,10)} -> ${p.toDate.toISOString().slice(0,10)} @ balance ₹${p.balance} for ${p.monthsHeld} months = ₹${p.interest}`));
        line(`Total: ₹${ob3.totalInterest}`);
        // Expect: Apr-Jun (3 months incl June, since addition delayed to July) @ 3000, then Jul-Mar (9 months) @ 7000
        const expected3 = Math.round((3000 * 0.07 * 3/12 + 7000 * 0.07 * 9/12) * 100) / 100;
        line(`Manual expectation (LOAN_ADDITION delayed to next month: 3mo@3000 [Apr,May,Jun] + 9mo@7000 [Jul..Mar]): ₹${expected3} -> MATCH: ${ob3.totalInterest === expected3 ? 'YES' : 'MISMATCH!!'}`);

        // Confirm loan eligibility reads RD via getTotalCurrentHoldings correctly (opening pot + installments - withdrawn)
        await memberConfig.setMonthlyAmount(m3, YEARCODE, 300, 'tester');
        await repayment.recordPayment(m3, YEARCODE, 4, 2026, 300, new Date(2026,3,5), 'on-time', 'tester');
        const holdings3 = await balanceEvents.getTotalCurrentHoldings(m3, YEARCODE);
        line(`getTotalCurrentHoldings after opening 3000 + loan addition 4000 + 1 installment 300 = ${holdings3} (expect 7300)`);

        // ============================================================
        // SCENARIO 4: RD used to close a loan early (RD-then-Share drawdown)
        // ============================================================
        header('SCENARIO 4: Early loan closure drawing down RD (then Share) — verify what happens to each');
        const shareBalRows = await ds.query(`SELECT shares FROM member_balances WHERE mbno = $1`, [m3]);
        line(`Member ${m3} current share balance (before any test insert): ${shareBalRows[0]?.shares ?? 'no row'}`);
        // Give this member a share balance directly so both RD and Share have something to draw from
        // (member_balances has no unique constraint on mbno to ON CONFLICT against)
        const existingBalRow = await ds.query(`SELECT mbno FROM member_balances WHERE mbno::text = $1`, [m3]);
        if (existingBalRow.length > 0) {
            await ds.query(`UPDATE member_balances SET shares = 2000 WHERE mbno::text = $1`, [m3]);
        } else {
            await ds.query(`INSERT INTO member_balances (mbno, shares) VALUES ($1, 2000)`, [Number(m3)]);
        }
        const adjustment = await loanEligibility.getRdShareClosureAdjustment(m3, 10000);
        line(`getRdShareClosureAdjustment(member=${m3}, finalClosureAmount=10000):`);
        line(`  currentRd=${adjustment.currentRd}, currentShare=${adjustment.currentShare}`);
        line(`  rdMinBalance=${adjustment.rdMinBalance}, shareMinBalance=${adjustment.shareMinBalance}`);
        line(`  rdAvailable=${adjustment.rdAvailable}, shareAvailable=${adjustment.shareAvailable}`);
        line(`  fromRd=${adjustment.fromRd}, fromShare=${adjustment.fromShare}, payableByMember=${adjustment.payableByMember}`);
        line(`  NOTE: RD is drawn BEFORE Share per spec, and RD withdrawal goes through recordWithdrawal (writes an audit row in rd_balance_events).`);
        line(`  NOTE: Share deduction (in loan-repayment.service.ts) DIRECTLY debits member_balances.shares with a raw UPDATE — no ledger/audit row is written for that debit anywhere (confirmed by reading loan-repayment.service.ts lines ~1200); RD leaves a full audit trail, Share does not.`);

        // ============================================================
        // SCENARIO 5: Payment pattern variations
        // ============================================================
        header('SCENARIO 5: Payment pattern eligibility — gap patterns');

        // 5a: one gap, recovered quickly -> still eligible
        const m5a = await makeMember(memberCrud, 'GAPRECOVERED');
        await memberConfig.setMonthlyAmount(m5a, YEARCODE, 400, 'tester');
        const months = [[4,2026],[5,2026],[6,2026],[7,2026],[8,2026],[9,2026],[10,2026],[11,2026],[12,2026],[1,2027],[2,2027],[3,2027]];
        for (const [mo, yr] of months) {
            if (mo === 6 && yr === 2026) continue; // skip June - will clear later as arrear
            const paidDate = new Date(yr, mo - 1, 5);
            await repayment.recordPayment(m5a, YEARCODE, mo, yr, 400, paidDate, 'on-time', 'tester');
        }
        // clear June arrear in August (2 months late - within RULE_RD_MAX_ARREARS_CLEARANCE_MONTHS=3)
        await repayment.recordPayment(m5a, YEARCODE, 6, 2026, 400, new Date(2026, 7, 20), 'arrear clearance', 'tester');
        const eval5a = await patternElig.evaluateMember(m5a, YEARCODE);
        line(`5a) One gap (June) recovered in August (2mo late): pattern=${eval5a.detectedPattern}, autoEligible=${eval5a.autoEligibleFullInterest}, reasons=${JSON.stringify(eval5a.disqualifyingReasons)}`);

        // 5b: gap never recovered -> not eligible
        const m5b = await makeMember(memberCrud, 'GAPUNRECOVERED');
        await memberConfig.setMonthlyAmount(m5b, YEARCODE, 400, 'tester');
        for (const [mo, yr] of months) {
            if (mo === 6 && yr === 2026) continue; // June never paid at all
            await repayment.recordPayment(m5b, YEARCODE, mo, yr, 400, new Date(yr, mo - 1, 5), 'on-time', 'tester');
        }
        const eval5b = await patternElig.evaluateMember(m5b, YEARCODE);
        line(`5b) One gap (June) NEVER recovered: pattern=${eval5b.detectedPattern}, autoEligible=${eval5b.autoEligibleFullInterest}, reasons=${JSON.stringify(eval5b.disqualifyingReasons)}`);
        const interest5b = await interestCalc.previewTotalInterest(m5b, YEARCODE);
        line(`   Installment interest (should be LESS than full-year formula since ineligible + one missing installment): ₹${interest5b.installmentInterest.totalInterest} vs full regular ₹${fullYearInstallmentInterest(400, RATE)}`);

        // 5c: multiple gaps -> not eligible (policy default disallows multiple gaps)
        const m5c = await makeMember(memberCrud, 'MULTIGAPS');
        await memberConfig.setMonthlyAmount(m5c, YEARCODE, 400, 'tester');
        for (const [mo, yr] of months) {
            if ((mo === 6 && yr === 2026) || (mo === 10 && yr === 2026)) continue;
            await repayment.recordPayment(m5c, YEARCODE, mo, yr, 400, new Date(yr, mo - 1, 5), 'on-time', 'tester');
        }
        await repayment.recordPayment(m5c, YEARCODE, 6, 2026, 400, new Date(2026, 6, 10), 'arrear', 'tester');
        await repayment.recordPayment(m5c, YEARCODE, 10, 2026, 400, new Date(2026, 10, 10), 'arrear', 'tester');
        const eval5c = await patternElig.evaluateMember(m5c, YEARCODE);
        line(`5c) Two separate gaps, both recovered: pattern=${eval5c.detectedPattern}, autoEligible=${eval5c.autoEligibleFullInterest}, reasons=${JSON.stringify(eval5c.disqualifyingReasons)}`);

        // 5d: gap longer than max tolerated gap months
        const m5d = await makeMember(memberCrud, 'LONGGAP');
        await memberConfig.setMonthlyAmount(m5d, YEARCODE, 400, 'tester');
        for (const [mo, yr] of months) {
            if ((mo===6&&yr===2026)||(mo===7&&yr===2026)||(mo===8&&yr===2026)||(mo===9&&yr===2026)) continue; // 4-month gap > RULE_RD_MAX_PAYMENT_GAP_MONTHS=3
            await repayment.recordPayment(m5d, YEARCODE, mo, yr, 400, new Date(yr, mo - 1, 5), 'on-time', 'tester');
        }
        for (const [mo, yr] of [[6,2026],[7,2026],[8,2026],[9,2026]] as [number,number][]) {
            await repayment.recordPayment(m5d, YEARCODE, mo, yr, 400, new Date(2026, 9, 15), 'arrear', 'tester');
        }
        const eval5d = await patternElig.evaluateMember(m5d, YEARCODE);
        line(`5d) 4-consecutive-month gap (exceeds max tolerated 3): pattern=${eval5d.detectedPattern}, autoEligible=${eval5d.autoEligibleFullInterest}, reasons=${JSON.stringify(eval5d.disqualifyingReasons)}`);

        // ============================================================
        // SCENARIO 6: Partial payment handling
        // ============================================================
        header('SCENARIO 6: Partial installment payment');
        const m6 = await makeMember(memberCrud, 'PARTIAL');
        await memberConfig.setMonthlyAmount(m6, YEARCODE, 500, 'tester');
        await repayment.recordPayment(m6, YEARCODE, 4, 2026, 300, new Date(2026, 3, 5), 'partial', 'tester'); // only 300 of 500
        const pending6 = await repayment.getPendingInstallments(m6, YEARCODE);
        line(`April row after partial ₹300 payment (expected ₹500): status=${pending6[0].status}, paidAmount=${pending6[0].paidAmount}`);
        const interest6 = await interestCalc.calculateInstallmentInterest(m6, YEARCODE, true);
        line(`Installment interest counts PAID rows only (paid_amount >= expected_amount) -> rows counted: ${interest6.rows.length} (should be 0, partial doesn't count)`);

        // ============================================================
        // SCENARIO 7: Double-close / re-withdraw-after-close guard
        // ============================================================
        header('SCENARIO 7: Guard rails — closing twice, withdrawing after close');
        try {
            await fyClosing.closeMemberYear(m1, YEARCODE, 'tester');
            line('!!! UNEXPECTED: double-close was allowed for member ' + m1);
        } catch (e: any) {
            line(`Double-close correctly REJECTED: ${e.message}`);
        }
        try {
            await balanceEvents.recordWithdrawal(m1, YEARCODE, 100, new Date(2027, 2, 20), 'tester');
            line('!!! UNEXPECTED: withdrawal after year-close was allowed for member ' + m1);
        } catch (e: any) {
            line(`Withdrawal-after-close correctly REJECTED: ${e.message}`);
        }
        try {
            await repayment.recordPayment(m1, YEARCODE, 4, 2026, 500, new Date(2027, 2, 20), 'late', 'tester');
            line('!!! UNEXPECTED: payment recorded after year-close was allowed for member ' + m1);
        } catch (e: any) {
            line(`Payment-after-close correctly REJECTED: ${e.message}`);
        }

        header('ALL TEST MEMBERS CREATED (for manual DB inspection if needed):');
        line(`m1(REGULAR)=${m1} m2(WITHDRAW)=${m2} m3(LOANADD)=${m3} m5a=${m5a} m5b=${m5b} m5c=${m5c} m5d=${m5d} m6(PARTIAL)=${m6}`);

    } finally {
        await app.close();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
