// Creates 3 new members and disburses one Rs.1,00,000 / 12-installment
// Emergency Loan for each, entirely through the real application code
// (application -> sanction -> voucher -> pass), for a clean full-12-month
// repayment scenario test unpolluted by earlier test data.
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MemberCrudService } from '../modules/member/services-v2/member-crud.service';
import { LoanApplicationService } from '../modules/loan/services-v2/loan-application.service';
import { LoanSanctionService } from '../modules/loan/services-v2/loan-sanction.service';
import { VoucherService } from '../modules/transaction/services-v2/voucher.service';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';

const LABELS = ['Loan 1 (on-time + cascade)', 'Loan 2 (advance mode)', 'Loan 3 (partial/custom + overpay)'];

async function main() {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const memberCrud = app.get(MemberCrudService);
        const loanApp = app.get(LoanApplicationService);
        const loanSanction = app.get(LoanSanctionService);
        const voucherSvc = app.get(VoucherService);
        const passSvc = app.get(PassTransactionService);
        const dataSource = app.get(DataSource);

        const results: any[] = [];

        for (const label of LABELS) {
            console.log(`\n=== ${label} ===`);
            const member = await memberCrud.saveMemberMaster({
                mbno: 'auto',
                f_name: 'FRESHLOAN',
                l_name: label.split(' ')[1],
                officeno: 2,
                branchmsno: '1-POWERHOUSE-POWERHOUSE-94',
                isactive: 'Y',
                memb_date: new Date(),
            });
            const mbno = String(member.mbno);
            console.log('  member:', mbno);

            const application = await loanApp.saveLoanApplication({
                memberNo: mbno,
                loanAmount: 100000,
                noOfInstallments: 12,
                loanType: 'EMERGENCY',
                reason: 'Fresh clean-loan repayment scenario test',
                applDate: new Date(),
            });
            const caseNo = String(application.loanCaseNo ?? application.data?.loancaseno);
            console.log('  case:', caseNo);

            await loanSanction.updateLoanSanction(caseNo, {
                sanctionedAmount: 100000,
                sanctionDate: new Date(),
                noOfInstallments: 12,
            });

            const voucherResult = await voucherSvc.generateLoanVoucher({
                loanCaseNo: caseNo,
                paymentMode: 'CASH',
                breakdown: [
                    { srNo: 1, code: 'A1047', name: 'Emergency Loan Disbursement', rp: 'Payment', amount: 100000 },
                ],
            });
            console.log('  voucher:', voucherResult.voucherNo);

            await passSvc.passTransaction(voucherResult.voucherNo, 'test-script');

            const loanRow = await dataSource.query(
                `SELECT loancaseno, mbno, loan_amt, rate, no_of_instal, instal_amt, balance, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date
                 FROM loan_master WHERE loancaseno::text = $1`,
                [caseNo]
            );
            const rbRows = await dataSource.query(
                `SELECT COUNT(*) as cnt FROM loan_rb_schedule WHERE loancaseno::text = $1`,
                [caseNo]
            );
            console.log('  loan_master:', loanRow[0]);
            console.log('  rb_schedule rows:', rbRows[0]?.cnt);
            results.push({ label, caseNo, mbno, ...loanRow[0], rbRows: rbRows[0]?.cnt });
        }

        console.log('\n=== SUMMARY ===');
        console.table(results.map(r => ({
            label: r.label, caseNo: r.caseNo, mbno: r.mbno, loan_amt: r.loan_amt, rate: r.rate,
            no_of_instal: r.no_of_instal, instal_amt: r.instal_amt, balance: r.balance, rbRows: r.rbRows,
        })));
    } finally {
        await app.close();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
