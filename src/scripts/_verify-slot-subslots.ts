/**
 * Creates three real test members and passes one real loan for each slot
 * scenario through the application services. The fixtures are intentionally
 * retained in the database for frontend inspection; this script never deletes
 * them.
 */
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MemberCrudService } from '../modules/member/services-v2/member-crud.service';
import { LoanApplicationService } from '../modules/loan/services-v2/loan-application.service';
import { LoanSanctionService } from '../modules/loan/services-v2/loan-sanction.service';
import { VoucherService } from '../modules/transaction/services-v2/voucher.service';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';
import {
    calculateConstantEmi,
    determineLoanSlot,
    firstDueMonthFromDisbursement,
} from '../modules/loan/services-v2/loan-rb-schedule.util';

const SLOT_RULES = {
    slot1DelayMonths: 1,
    slot2DelayMonths: 2,
    slot1StartDay: 25,
    slot1EndDay: 5,
} as const;

const CASES = [
    { label: 'Slot 1 late-month', date: new Date(2026, 5, 28), subSlot: 'LATE_MONTH', firstDueDelayMonths: 2, interestDelayMonths: 1 },
    { label: 'Slot 1 early-month', date: new Date(2026, 6, 2), subSlot: 'EARLY_MONTH', firstDueDelayMonths: 1, interestDelayMonths: 1 },
    { label: 'Slot 2 middle-month', date: new Date(2026, 6, 10), subSlot: null, firstDueDelayMonths: 2, interestDelayMonths: 2 },
] as const;

function assertEqual(actual: unknown, expected: unknown, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
    }
}

function monthKey(value: Date): string {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

async function main() {
    for (const scenario of CASES) {
        const slot = determineLoanSlot(
            scenario.date,
            SLOT_RULES.slot1DelayMonths,
            SLOT_RULES.slot2DelayMonths,
            SLOT_RULES.slot1StartDay,
            SLOT_RULES.slot1EndDay,
        );
        assertEqual(slot.subSlot, scenario.subSlot, `${scenario.label} sub-slot`);
        assertEqual(slot.firstDueDelayMonths, scenario.firstDueDelayMonths, `${scenario.label} first EMI delay`);
        assertEqual(slot.interestDelayMonths, scenario.interestDelayMonths, `${scenario.label} interest delay`);

        const emi = calculateConstantEmi(
            10000,
            12,
            10,
            scenario.date,
            SLOT_RULES.slot1DelayMonths,
            SLOT_RULES.slot2DelayMonths,
            'NEAREST',
            SLOT_RULES.slot1StartDay,
            SLOT_RULES.slot1EndDay,
        );
        assertEqual(emi.subSlot, scenario.subSlot, `${scenario.label} EMI sub-slot`);
        assertEqual(emi.firstDueDelayMonths, scenario.firstDueDelayMonths, `${scenario.label} EMI first delay`);
        assertEqual(emi.interestDelayMonths, scenario.interestDelayMonths, `${scenario.label} EMI interest delay`);
        console.log(`${scenario.label}: utility assertions passed`);
    }

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const memberCrud = app.get(MemberCrudService);
        const loanApp = app.get(LoanApplicationService);
        const loanSanction = app.get(LoanSanctionService);
        const voucherSvc = app.get(VoucherService);
        const passSvc = app.get(PassTransactionService);
        const dataSource = app.get(DataSource);
        const disbursedAt = new Date();
        const results: any[] = [];

        for (const scenario of CASES) {
            const member = await memberCrud.saveMemberMaster({
                mbno: 'auto',
                f_name: 'SLOTTEST',
                l_name: scenario.label.replace(/[^A-Z0-9]+/gi, '_').toUpperCase(),
                officeno: 2,
                branchmsno: '1-POWERHOUSE-POWERHOUSE-94',
                isactive: 'Y',
                memb_date: disbursedAt,
            });
            const mbno = String(member.mbno);
            const application = await loanApp.saveLoanApplication({
                memberNo: mbno,
                loanAmount: 10000,
                noOfInstallments: 10,
                loanType: 'EMERGENCY',
                reason: `Retained slot sub-slot verification: ${scenario.label}`,
                applDate: scenario.date,
            });
            const caseNo = String(application.loanCaseNo ?? application.data?.loancaseno);
            await loanSanction.updateLoanSanction(caseNo, {
                sanctionedAmount: 10000,
                sanctionDate: disbursedAt,
                noOfInstallments: 10,
            });
            const voucher = await voucherSvc.generateLoanVoucher({
                loanCaseNo: caseNo,
                paymentMode: 'CASH',
                breakdown: [{ srNo: 1, code: 'A1047', name: 'Slot sub-slot verification', rp: 'Payment', amount: 10000 }],
            });
            await passSvc.passTransaction(voucher.voucherNo, 'slot-subslot-verification');

            const rows = await dataSource.query(
                `SELECT lm.loancaseno, lm.mbno, lm.delay_months,
                        sv.first_due_month, sv.delay_months AS schedule_delay
                   FROM loan_master lm
                   JOIN loan_schedule_versions sv
                     ON sv.mbno = lm.mbno
                    AND sv.loantype = lm.loantype
                    AND sv.loancaseno::text = lm.loancaseno::text
                  WHERE lm.mbno = $1 AND lm.loancaseno::text = $2`,
                [mbno, caseNo],
            );
            const row = rows[0];
            const expectedFirstDue = firstDueMonthFromDisbursement(disbursedAt, scenario.firstDueDelayMonths);
            assertEqual(Number(row.delay_months), scenario.firstDueDelayMonths, `${scenario.label} loan_master delay`);
            assertEqual(Number(row.schedule_delay), scenario.firstDueDelayMonths, `${scenario.label} schedule delay`);
            assertEqual(monthKey(new Date(row.first_due_month)), monthKey(expectedFirstDue), `${scenario.label} first due month`);
            results.push({
                label: scenario.label,
                mbno,
                caseNo,
                subSlot: scenario.subSlot ?? 'NONE',
                interestDelayMonths: scenario.interestDelayMonths,
                firstDueDelayMonths: scenario.firstDueDelayMonths,
                firstDueMonth: monthKey(new Date(row.first_due_month)),
            });
        }

        console.table(results);
        console.log('All utility and real disbursement slot tests passed.');
        console.log('Test members and loans were intentionally retained in the database.');
    } finally {
        try {
            await app.close();
        } catch (error) {
            // The application context has an existing TypeORM shutdown-hook
            // issue in this local setup. The database assertions already ran;
            // do not turn cleanup noise into a failed slot result.
            console.warn('Test context cleanup warning:', error instanceof Error ? error.message : error);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
