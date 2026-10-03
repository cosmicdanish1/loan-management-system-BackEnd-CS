import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { MemberLedgerService } from '../modules/member-ledger/member-ledger.service';
const fmtD = (v: any) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(v)).replace(/ /g, '-');
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function main() {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    const svc = app.get(MemberLedgerService);
    for (const mb of process.argv[2].split(',')) {
        const r: any = await svc.getMemberDetailLedgerReport({ memberNumber: mb, fromDate: '2025-01-01', toDate: '2026-10-01' } as any);
        console.log(`\n===== ${mb} ${r.memberName} =====`);
        for (const e of r.entries.filter((x: any) => x.code === 'A1002')) {
            console.log(`${fmtD(e.date)}  ${String(e.voucherNo).padEnd(8)} ${(e.debit ? inr(e.debit) : '').padStart(12)} ${(e.credit ? inr(e.credit) : '').padStart(12)}  bal ${inr(Math.abs(e.balance ?? 0))} DR   ${(e.particulars || '').slice(0, 40)}`);
        }
    }
    try { await app.close(); } catch {}
}
main();
