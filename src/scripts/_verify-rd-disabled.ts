// One fresh loan disbursement, created purely to verify the RD requirement
// is now disabled (no RD deduction posted) while Share Value enforcement
// still works, after removing the fdmaster-based RD account system.
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
            mbno: 'auto', f_name: 'RDDISABLED', l_name: 'VERIFY',
            officeno: 2, branchmsno: '1-POWERHOUSE-POWERHOUSE-94',
            isactive: 'Y', memb_date: new Date(),
        });
        const mbno = String(member.mbno);

        const application = await loanApp.saveLoanApplication({
            memberNo: mbno, loanAmount: 40000, noOfInstallments: 12,
            loanType: 'EMERGENCY', reason: 'RD-disabled verification', applDate: new Date(),
        });
        const caseNo = String(application.loanCaseNo ?? application.data?.loancaseno);

        await loanSanction.updateLoanSanction(caseNo, { sanctionedAmount: 40000, sanctionDate: new Date(), noOfInstallments: 12 });

        const voucherResult = await voucherSvc.generateLoanVoucher({
            loanCaseNo: caseNo, paymentMode: 'CASH',
            breakdown: [{ srNo: 1, code: 'A1047', name: 'Emergency Loan Disbursement', rp: 'Payment', amount: 40000 }],
        });
        await passSvc.passTransaction(voucherResult.voucherNo, 'test-script');

        const ledgerRows = await dataSource.query(
            `SELECT code, trans_type, trans_amt, narration FROM ledger WHERE acc_no::text = $1 ORDER BY ledgerid`,
            [caseNo]
        );
        console.log('CASE:', caseNo, 'MEMBER:', mbno, '(0 Share balance, so expect Share deduction too — this member has none, expect only the main A1047 leg, no RD/L1004 leg at all)');
        console.table(ledgerRows);
    } finally {
        await app.close();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
