// One fresh loan disbursement, created purely to verify BUG FIX 41 in
// pass-transaction.service.ts (loan-disbursement ledger legs were hardcoded
// trans_type='P' instead of a real DR/CR direction).
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
            mbno: 'auto', f_name: 'DRCRFIX', l_name: 'VERIFY',
            officeno: 2, branchmsno: '1-POWERHOUSE-POWERHOUSE-94',
            isactive: 'Y', memb_date: new Date(),
        });
        const mbno = String(member.mbno);

        const application = await loanApp.saveLoanApplication({
            memberNo: mbno, loanAmount: 50000, noOfInstallments: 12,
            loanType: 'EMERGENCY', reason: 'DR/CR fix verification', applDate: new Date(),
        });
        const caseNo = String(application.loanCaseNo ?? application.data?.loancaseno);

        await loanSanction.updateLoanSanction(caseNo, { sanctionedAmount: 50000, sanctionDate: new Date(), noOfInstallments: 12 });

        const voucherResult = await voucherSvc.generateLoanVoucher({
            loanCaseNo: caseNo, paymentMode: 'CASH',
            breakdown: [{ srNo: 1, code: 'A1047', name: 'Emergency Loan Disbursement', rp: 'Payment', amount: 50000 }],
        });
        await passSvc.passTransaction(voucherResult.voucherNo, 'test-script');

        const ledgerRows = await dataSource.query(
            `SELECT code, trans_type, vchr_type, trans_amt, narration FROM ledger WHERE acc_no::text = $1 ORDER BY ledgerid`,
            [caseNo]
        );
        console.log('CASE:', caseNo, 'MEMBER:', mbno);
        console.table(ledgerRows);
    } finally {
        await app.close();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
