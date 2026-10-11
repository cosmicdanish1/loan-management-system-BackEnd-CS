// Boots the real Nest application context (no HTTP port) and checks that the re-agreement providers are wired
// into both the Loan and the Transaction modules and into the services that call them.
//   npx ts-node --transpile-only src/scripts/_check_reagreement_wiring.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { LoanReagreementController } from '../modules/loan/loan-reagreement.controller';
import { LoanReagreementService } from '../modules/loan/services-v2/reagreement/loan-reagreement.service';
import { LoanSanctionService } from '../modules/loan/services-v2/loan-sanction.service';
import { VoucherService } from '../modules/transaction/services-v2/voucher.service';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';

async function main() {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    let failed = 0;
    const check = (label: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
    try {
        const ctrl = app.get(LoanReagreementController, { strict: false });
        check('LoanReagreementController is registered', !!ctrl);
        const svc = app.get(LoanReagreementService, { strict: false });
        check('LoanReagreementService resolves', !!svc);
        check('PassTransactionService has the re-agreement service injected', !!(app.get(PassTransactionService, { strict: false }) as any).reagreementService);
        check('VoucherService has the re-agreement service injected', !!(app.get(VoucherService, { strict: false }) as any).reagreementService);
        check('LoanSanctionService has the re-agreement service injected', !!(app.get(LoanSanctionService, { strict: false }) as any).reagreementService);
        const rules = await svc.getRules();
        check('rules default to permissive', rules.maxTenure === 0 && rules.allowRateIncrease === true && rules.allowBackdate === false);
        console.log('rules', JSON.stringify(rules));
        const open = await svc.listOpen();
        check('listOpen works against the database', Array.isArray(open));
    } finally {
        await app.close();
    }
    console.log(failed ? `${failed} FAILED` : 'wiring OK');
    process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
