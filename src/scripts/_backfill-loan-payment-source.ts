import 'dotenv/config';
// Adds loan_repayment_ledger.payment_source (migration 1790726400000) and tags migrated history:
// a replayed repayment whose date + principal match a DEMAND voucher ('D') on the member's loan head in `ledger`
// is tagged 'DEMAND'. Everything else stays 'CASH' (the old, pooled behaviour). Safe to re-run.
import { DataSource } from 'typeorm';
import { AddLoanRepaymentPaymentSource1790726400000 } from '../migrations/1790726400000-AddLoanRepaymentPaymentSource';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: process.env.DB_PASSWORD, entities: [], synchronize: false, logging: false,
});

async function main() {
    await ds.initialize();
    const qr = ds.createQueryRunner();
    await qr.connect();
    await new AddLoanRepaymentPaymentSource1790726400000().up(qr);
    await qr.release();
    console.log('payment_source column is in place.');

    const members = await ds.query(`SELECT DISTINCT mbno FROM loan_repayment_ledger WHERE narration LIKE 'Legacy ledger replay%' ORDER BY mbno`);
    console.log('members to scan:', members.length);
    const CHUNK = 400;
    let tagged = 0;
    for (let i = 0; i < members.length; i += CHUNK) {
        const ids = members.slice(i, i + CHUNK).map((m: any) => String(m.mbno));
        const res = await ds.query(
            `UPDATE loan_repayment_ledger r SET payment_source = 'DEMAND'
              WHERE r.mbno::text = ANY($1) AND r.payment_source <> 'DEMAND' AND r.narration LIKE 'Legacy ledger replay%'
                AND EXISTS (SELECT 1 FROM ledger l
                             WHERE l.mbno = r.mbno AND l.code = CASE WHEN r.loantype = 'RLN' THEN 'A1002' ELSE 'A1047' END
                               AND l.vchr_type = 'D' AND l.trans_type = 'CR'
                               AND (l.trans_date + interval '5 hours 30 minutes')::date = r.payment_date
                               AND ABS(l.trans_amt - r.principal_amount) < 0.01)`,
            [ids],
        );
        tagged += Array.isArray(res) ? Number(res[1] ?? 0) : 0;
        if ((i / CHUNK) % 5 === 0) console.log(`  scanned ${Math.min(i + CHUNK, members.length)} / ${members.length} members, tagged so far ${tagged}`);
    }
    const summary = await ds.query(`SELECT payment_source, COUNT(*)::int AS n FROM loan_repayment_ledger GROUP BY 1 ORDER BY 1`);
    console.log('rows by source:', JSON.stringify(summary));
    await ds.destroy();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
