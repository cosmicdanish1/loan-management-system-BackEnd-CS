// Renders a sample re-agreement (text + PDF + PNG) to a folder, to eyeball the layout.
//   npx ts-node --transpile-only src/scripts/_test_reagreement_render.ts <outDir> [mbnoWithSignature]
import * as fs from 'fs';
import * as path from 'path';
import { ReagreementDocumentService } from '../modules/loan/services-v2/reagreement/reagreement-document.service';
import { AgreementData } from '../modules/loan/services-v2/reagreement/reagreement-agreement.layout';

(async () => {
    const out = process.argv[2] || '.';
    const mb = process.argv[3] || '610020500';
    fs.mkdirSync(out, { recursive: true });
    // No DB needed: signatures are looked up through this tiny stand-in.
    const fakeDb: any = {
        query: async (_sql: string, params: any[]) => {
            const rel = process.env.SIG_PATH || null;
            return params[0] === mb && rel ? [{ signature_image_path: rel }] : [];
        },
    };
    const svc = new ReagreementDocumentService(fakeDb);
    const data: AgreementData = {
        status: (process.env.DRAFT ? 'DRAFT' : 'FINAL'),
        reagreementNo: 'RA00001', issueNo: 1, issuedAt: new Date().toISOString(),
        applicationDate: '2026-10-12', effectiveDate: '2026-10-12', firstDueMonth: '2026-12-01',
        voucherNo: 'VCH042', reason: 'Member requested lower monthly installment',
        member: { mbno: mb, name: 'TEST MEMBER ONE', office: 'Bhilai Steel Plant' },
        sureties: [{ mbno: '610020501', name: 'SURETY ONE' }, { mbno: '610020502', name: 'SURETY TWO' }],
        loanType: 'RLN', loanTypeName: 'REGULAR LOAN', oldCaseNo: '18445', newCaseNo: '21001',
        old: { rate: 12, installments: 60, monthlyPrincipal: 5000, monthlyInterest: 1575, monthlyInstallment: 6575, paidInstallments: 24 },
        neu: { rate: 12, installments: 60, monthlyPrincipal: 3000, monthlyInterest: 1335, monthlyInstallment: 4335, slot: 1, delayMonths: 2, delayInterest: 1800, totalRbInterest: 54900, totalInterestForEmi: 80100 },
        outstandingPrincipal: 180000, nrInterest: 0, penaltyCollected: 0, carriedInterest: 23400, collectedNow: 0,
        oldRemainingPayable: 236700, newTotalPayable: 260100,
    };
    const r = await svc.renderAll(data, fakeDb);
    fs.writeFileSync(path.join(out, 'agreement.txt'), r.text);
    if (r.pdf) fs.writeFileSync(path.join(out, 'agreement.pdf'), r.pdf);
    if (r.png) fs.writeFileSync(path.join(out, 'agreement.png'), r.png);
    console.log('lines', r.layout.lines.length, 'pdf', r.pdf?.length, 'png', r.png?.length, 'err', r.renderError, JSON.stringify(r.signaturesUsed));
})().catch(e => { console.error(e); process.exit(1); });
