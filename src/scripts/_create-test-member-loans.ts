// Creates one new member and 4 loans entirely through the real application
// code — boots the actual Nest DI container so every service gets its real
// wiring, then calls the same service methods the controllers call.
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MemberCrudService } from '../modules/member/services-v2/member-crud.service';
import { LoanApplicationService } from '../modules/loan/services-v2/loan-application.service';
import { LoanSanctionService } from '../modules/loan/services-v2/loan-sanction.service';
import { VoucherService } from '../modules/transaction/services-v2/voucher.service';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';

interface LoanDef {
    label: string;
    amount: number;
    instal: number;
}

const LOAN_DEFS: LoanDef[] = [
    { label: 'Loan A (older, pairs with B for cascading)', amount: 150000, instal: 14 },
    { label: 'Loan B (younger sibling, same member/type)', amount: 90000, instal: 14 },
    { label: 'Loan C (miss+catchup+partial+early closure)', amount: 80000, instal: 12 },
    { label: 'Loan D (clean on-time + prepayment)', amount: 40000, instal: 10 },
];

async function main() {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

    try {
        const memberCrud = app.get(MemberCrudService);
        const loanApp = app.get(LoanApplicationService);
        const loanSanction = app.get(LoanSanctionService);
        const voucherSvc = app.get(VoucherService);
        const passSvc = app.get(PassTransactionService);
        const dataSource = app.get(DataSource);

        console.log('--- Creating member via real MemberCrudService.saveMemberMaster ---');
        const member = await memberCrud.saveMemberMaster({
            mbno: 'auto',
            f_name: 'TESTCODE',
            l_name: 'CLEANTEST',
            officeno: 2,
            branchmsno: '1-POWERHOUSE-POWERHOUSE-94',
            isactive: 'Y',
            memb_date: new Date(),
        });
        const mbno = String(member.mbno);
        console.log('Created member mbno:', mbno);

        const results: any[] = [];

        for (const def of LOAN_DEFS) {
            console.log(`\n--- ${def.label} — applying ---`);
            const application = await loanApp.saveLoanApplication({
                memberNo: mbno,
                loanAmount: def.amount,
                noOfInstallments: def.instal,
                loanType: 'EMERGENCY',
                reason: 'Test loan for calculation verification',
                applDate: new Date(),
            });
            const caseNo = String(application.loanCaseNo ?? application.data?.loancaseno);
            console.log('  loan_pending case:', caseNo);

            console.log('  sanctioning...');
            await loanSanction.updateLoanSanction(caseNo, {
                sanctionedAmount: def.amount,
                sanctionDate: new Date(),
                noOfInstallments: def.instal,
            });

            console.log('  generating disbursement voucher...');
            const voucherResult = await voucherSvc.generateLoanVoucher({
                loanCaseNo: caseNo,
                paymentMode: 'CASH',
                breakdown: [
                    { srNo: 1, code: 'A1047', name: 'Emergency Loan Disbursement', rp: 'Payment', amount: def.amount },
                ],
            });
            console.log('  voucher:', voucherResult.voucherNo);

            console.log('  posting (pass transaction)...');
            await passSvc.passTransaction(voucherResult.voucherNo, 'test-script');

            const loanRow = await dataSource.query(
                `SELECT loancaseno, loan_amt, rate, no_of_instal, instal_amt, balance, penalrate FROM loan_master WHERE loancaseno::text = $1`,
                [caseNo]
            );
            console.log('  loan_master row:', loanRow[0]);
            results.push({ label: def.label, caseNo, mbno, ...loanRow[0] });
        }

        console.log('\n=== SUMMARY ===');
        console.table(results.map(r => ({
            label: r.label, caseNo: r.caseNo, loan_amt: r.loan_amt, rate: r.rate,
            no_of_instal: r.no_of_instal, instal_amt: r.instal_amt, balance: r.balance,
        })));
    } finally {
        await app.close();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
