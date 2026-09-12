// One more fresh Rs.1,00,000/12-installment loan, created purely to re-verify
// the advance-mode fix (BUG FIX 40 in loan-repayment.service.ts) against a
// loan untouched by the earlier (pre-fix) test data.
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MemberCrudService } from '../modules/member/services-v2/member-crud.service';
import { LoanApplicationService } from '../modules/loan/services-v2/loan-application.service';
import { LoanSanctionService } from '../modules/loan/services-v2/loan-sanction.service';
import { VoucherService } from '../modules/transaction/services-v2/voucher.service';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';

async function main() {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const memberCrud = app.get(MemberCrudService);
        const loanApp = app.get(LoanApplicationService);
        const loanSanction = app.get(LoanSanctionService);
        const voucherSvc = app.get(VoucherService);
        const passSvc = app.get(PassTransactionService);
        const dataSource = app.get(DataSource);

        const member = await memberCrud.saveMemberMaster({
            mbno: 'auto', f_name: 'FRESHLOAN', l_name: 'RETEST',
            officeno: 2, branchmsno: '1-POWERHOUSE-POWERHOUSE-94',
            isactive: 'Y', memb_date: new Date(),
        });
        const mbno = String(member.mbno);

        const application = await loanApp.saveLoanApplication({
            memberNo: mbno, loanAmount: 100000, noOfInstallments: 12,
            loanType: 'EMERGENCY', reason: 'Advance-mode fix re-verification', applDate: new Date(),
        });
        const caseNo = String(application.loanCaseNo ?? application.data?.loancaseno);

        await loanSanction.updateLoanSanction(caseNo, { sanctionedAmount: 100000, sanctionDate: new Date(), noOfInstallments: 12 });

        const voucherResult = await voucherSvc.generateLoanVoucher({
            loanCaseNo: caseNo, paymentMode: 'CASH',
            breakdown: [{ srNo: 1, code: 'A1047', name: 'Emergency Loan Disbursement', rp: 'Payment', amount: 100000 }],
        });
        await passSvc.passTransaction(voucherResult.voucherNo, 'test-script');

        const loanRow = await dataSource.query(
            `SELECT loancaseno, mbno, loan_amt, instal_amt, no_of_instal, balance FROM loan_master WHERE loancaseno::text = $1`,
            [caseNo]
        );
        console.log('CREATED:', JSON.stringify(loanRow[0]));
    } finally {
        await app.close();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
