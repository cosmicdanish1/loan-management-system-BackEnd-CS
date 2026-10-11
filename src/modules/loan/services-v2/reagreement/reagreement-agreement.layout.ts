/**
 * Legacy-style monospace layout of the LOAN RE-AGREEMENT document.
 *
 * One layout model, drawn by thin renderers (text / PDF / PNG) so the stored
 * text, the PDF, the image and the on-screen preview are always identical.
 * The text is produced from plain data only (no database access), which keeps
 * it deterministic and unit-testable. Follows the society's legacy print
 * standard: monospace, plain black on white, centred letterhead, dashed rules.
 */

export const AGREEMENT_WIDTH = 90;
export const SOCIETY_NAME = 'Espat Karmchari Co-Operative Credit Society Limited.';
export const SOCIETY_ADDRESS = 'Avenue A, Sahakari Sadan, Sector-C, AT Post: Bhilai Nagar, Dist: DURG-490006';

/** Lines reserved above a signature caption for the signature image. */
export const SIGNATURE_BAND_LINES = 4;

export interface AgreementPerson {
    mbno: string;
    name: string;
    office?: string;
}

export interface AgreementTerms {
    rate: number;
    installments: number;
    monthlyPrincipal: number;
    monthlyInterest: number;
    monthlyInstallment: number;
}

export interface AgreementData {
    /** 'FINAL' once passed; 'DRAFT' for the watermarked preview printed before pass. */
    status: 'FINAL' | 'DRAFT';
    reagreementNo: string;
    issueNo: number;
    issuedAt: string;            // ISO timestamp
    applicationDate: string;     // YYYY-MM-DD
    effectiveDate: string | null;
    firstDueMonth: string | null; // YYYY-MM-DD (1st of month)
    voucherNo: string | null;
    reason: string;

    member: AgreementPerson;
    sureties: AgreementPerson[];
    loanType: string;
    loanTypeName: string;
    oldCaseNo: string;
    newCaseNo: string;

    old: AgreementTerms & { paidInstallments: number };
    neu: AgreementTerms & {
        slot: number | null;
        delayMonths: number | null;
        delayInterest: number;
        totalRbInterest: number;
        totalInterestForEmi: number;
    };

    outstandingPrincipal: number;
    nrInterest: number;
    penaltyCollected: number;
    carriedInterest: number;
    collectedNow: number;
    oldRemainingPayable: number;
    newTotalPayable: number;
}

export interface SignatureSlot {
    key: string;        // 'BORROWER' | 'SURETY1' | 'SURETY2' | 'SOCIETY'
    label: string;
    mbno: string | null;
    /** Index in `lines` of the first reserved (blank) line of the signature band. */
    lineIndex: number;
    /** Column where the caption/line starts. */
    column: number;
    /** Width in columns of the signature caption. */
    widthCols: number;
}

export interface AgreementLayout {
    lines: string[];
    signatureSlots: SignatureSlot[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '-';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return String(iso);
    return `${m[3]}-${MONTHS[parseInt(m[2], 10) - 1]}-${m[1]}`;
}

export function fmtMonth(iso: string | null | undefined): string {
    if (!iso) return '-';
    const m = /^(\d{4})-(\d{2})/.exec(iso);
    if (!m) return String(iso);
    return `${MONTHS[parseInt(m[2], 10) - 1]}-${m[1]}`;
}

export function fmtMoney(n: number): string {
    const v = Number.isFinite(n) ? n : 0;
    return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}/${h}:${mm}${ampm}`;
}

const center = (text: string, w = AGREEMENT_WIDTH) => {
    if (text.length >= w) return text.slice(0, w);
    const left = Math.floor((w - text.length) / 2);
    return ' '.repeat(left) + text;
};
const rule = (ch = '-', w = AGREEMENT_WIDTH) => ch.repeat(w);
const padR = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s.slice(-n) : ' '.repeat(n - s.length) + s);

/** Wraps a paragraph to the document width (2-space indent). */
function wrap(text: string, indent = 2, w = AGREEMENT_WIDTH): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let cur = ' '.repeat(indent);
    for (const word of words) {
        if ((cur + word).length > w - indent && cur.trim().length > 0) {
            out.push(cur.replace(/\s+$/, ''));
            cur = ' '.repeat(indent) + word + ' ';
        } else {
            cur += word + ' ';
        }
    }
    if (cur.trim().length > 0) out.push(cur.replace(/\s+$/, ''));
    return out;
}

function twoCol(left: string, right: string, leftW = 46): string {
    return padR(left, leftW) + right;
}

export function buildAgreementLayout(d: AgreementData): AgreementLayout {
    const L: string[] = [];
    const slots: SignatureSlot[] = [];
    const W = AGREEMENT_WIDTH;

    L.push(center(SOCIETY_NAME));
    L.push(center(SOCIETY_ADDRESS));
    L.push('');
    L.push(center('LOAN RE-AGREEMENT'));
    if (d.status === 'DRAFT') L.push(center('*** DRAFT COPY - NOT VALID UNTIL PASSED ***'));
    L.push(rule());

    L.push(twoCol(`Re-agreement No : ${d.reagreementNo}${d.issueNo > 1 ? ` (copy ${d.issueNo})` : ''}`, `Date : ${fmtDate(d.applicationDate)}`));
    L.push(twoCol(`Member No       : ${d.member.mbno}`, `Name : ${d.member.name}`));
    L.push(twoCol(`Loan Type       : ${d.loanTypeName} (${d.loanType})`, `Office : ${d.member.office || '-'}`));
    L.push(twoCol(`Old Loan Case   : ${d.oldCaseNo}`, `New Loan Case : ${d.newCaseNo}`));
    if (d.voucherNo) L.push(`Voucher No      : ${d.voucherNo}`);
    L.push(rule());

    L.push(center('TERMS OF THE LOAN'));
    L.push(rule());
    L.push(padR('', 38) + padL('Old Agreement', 24) + padL('New Agreement', 26));
    L.push(rule());
    const row = (label: string, a: string, b: string) => padR(label, 38) + padL(a, 24) + padL(b, 26);
    L.push(row('Interest rate (% p.a.)', d.old.rate.toFixed(2), d.neu.rate.toFixed(2)));
    L.push(row('Number of installments', String(d.old.installments), String(d.neu.installments)));
    L.push(row('Monthly principal (Rs.)', fmtMoney(d.old.monthlyPrincipal), fmtMoney(d.neu.monthlyPrincipal)));
    L.push(row('Monthly interest (Rs.)', fmtMoney(d.old.monthlyInterest), fmtMoney(d.neu.monthlyInterest)));
    L.push(row('Monthly installment (Rs.)', fmtMoney(d.old.monthlyInstallment), fmtMoney(d.neu.monthlyInstallment)));
    L.push(row('Installments already paid', String(d.old.paidInstallments), '0'));
    L.push(rule());

    L.push(center('POSITION ON THE DATE OF RE-AGREEMENT'));
    L.push(rule());
    const pos = (label: string, v: number) => padR(label, 62) + padL(fmtMoney(v), 28);
    L.push(pos('Outstanding principal carried into the new agreement (Rs.)', d.outstandingPrincipal));
    L.push(pos('Interest due and recovered now (NR interest) (Rs.)', d.nrInterest));
    L.push(pos('Penalty recovered now (Rs.)', d.penaltyCollected));
    L.push(pos('Total collected from the member now (Rs.)', d.collectedNow));
    L.push(pos('Closure interest of the old loan carried over (Rs.)', d.carriedInterest));
    L.push(pos('Delay interest of the new agreement (Rs.)', d.neu.delayInterest));
    L.push(pos('Total interest spread over the new installments (Rs.)', d.neu.totalInterestForEmi));
    L.push(rule());
    L.push(padR(`First installment month : ${fmtMonth(d.firstDueMonth)}`, 46)
        + (d.neu.slot ? `Slot : ${d.neu.slot}   Delay months : ${d.neu.delayMonths ?? '-'}` : ''));
    L.push(`Effective date          : ${fmtDate(d.effectiveDate)}`);
    if (d.reason) L.push(...wrap(`Reason : ${d.reason}`, 0));
    L.push(rule());

    L.push(center('DECLARATION'));
    L.push('');
    L.push(...wrap(
        `I/We, the borrower and the sureties named below, agree that the outstanding principal of Rs. ${fmtMoney(d.outstandingPrincipal)} `
        + `on loan case ${d.oldCaseNo} shall be carried into loan case ${d.newCaseNo} and repaid in ${d.neu.installments} monthly installments of `
        + `Rs. ${fmtMoney(d.neu.monthlyInstallment)} (principal Rs. ${fmtMoney(d.neu.monthlyPrincipal)} plus interest Rs. ${fmtMoney(d.neu.monthlyInterest)}) `
        + `at ${d.neu.rate.toFixed(2)}% per annum, the first installment falling in ${fmtMonth(d.firstDueMonth)}. `
        + `The earlier agreement stands closed on the date of this re-agreement and its history is preserved. `
        + `The sureties continue to be bound for the new agreement.`,
    ));
    L.push('');
    L.push(...wrap(
        `Total payable under the new agreement after the amounts recovered now: Rs. ${fmtMoney(d.newTotalPayable)} `
        + `(Rs. ${fmtMoney(d.oldRemainingPayable)} if the old agreement had continued unchanged).`,
    ));
    L.push('');

    // ---- signature blocks ----
    const blockW = 28;
    const rows: Array<Array<{ key: string; label: string; mbno: string | null; name: string }>> = [];
    const people: Array<{ key: string; label: string; mbno: string | null; name: string }> = [
        { key: 'BORROWER', label: 'Borrower', mbno: d.member.mbno, name: d.member.name },
    ];
    d.sureties.slice(0, 2).forEach((s, i) => people.push({ key: `SURETY${i + 1}`, label: `Surety ${i + 1}`, mbno: s.mbno, name: s.name }));
    people.push({ key: 'SOCIETY', label: 'For the Society', mbno: null, name: 'Authorised Signatory' });
    for (let i = 0; i < people.length; i += 3) rows.push(people.slice(i, i + 3));

    for (const r of rows) {
        const start = L.length;
        // reserved blank band for the signature image
        for (let i = 0; i < SIGNATURE_BAND_LINES; i++) L.push('');
        const lineA = Array(W).fill(' ');
        const lineB = Array(W).fill(' ');
        const lineC = Array(W).fill(' ');
        const lineD = Array(W).fill(' ');
        r.forEach((p, i) => {
            const col = i * (blockW + 3);
            slots.push({ key: p.key, label: p.label, mbno: p.mbno, lineIndex: start, column: col, widthCols: blockW });
            const put = (arr: string[], text: string) => {
                const t = text.slice(0, blockW);
                for (let k = 0; k < t.length; k++) arr[col + k] = t[k];
            };
            put(lineA, '-'.repeat(blockW));
            put(lineB, p.label);
            put(lineC, p.mbno ? `Member No ${p.mbno}` : p.name);
            if (p.mbno) put(lineD, p.name);
        });
        L.push(lineA.join('').replace(/\s+$/, ''));
        L.push(lineB.join('').replace(/\s+$/, ''));
        L.push(lineC.join('').replace(/\s+$/, ''));
        L.push(lineD.join('').replace(/\s+$/, ''));
        L.push('');
    }

    L.push(rule());
    L.push(padR(`* Printed on ${fmtDateTime(d.issuedAt)}`, 60) + (d.status === 'FINAL' ? 'Copy of record' : 'DRAFT'));
    L.push('* Re-agreement as per data available at the time of issue.');

    return { lines: L, signatureSlots: slots };
}
