import { Injectable, Logger, BadRequestException, OnModuleInit } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { randomUUID } from 'crypto';
import * as XLSX from 'xlsx';
import { toDateOnlyString } from '../../rd/rd-date-math';
import { LoanPaymentFlagService, LoanPaymentFlag } from '../../loan/services-v2/loan-payment-flag.service';

/**
 * ES-417: one rule for "the parts add up to the total", used by both the preview and saveRows. The preview used to
 * allow a whole rupee of difference while saveRows allowed one paisa, so a row the preview showed as Valid was then
 * silently skipped on save.
 */
const TOTAL_TOLERANCE = 0.01;
const totalsDiffer = (a: number, b: number) => Math.abs(Math.round((a - b) * 100) / 100) > TOTAL_TOLERANCE;

/**
 * Real Excel/CSV parsing for "Import Demand List".
 *
 * The payroll file comes from the old process and its header names must keep working exactly as they are (ES-586,
 * ES-587). Every field therefore accepts the old AND the new header name:
 *
 *   H.O.NO. | MS.NO.   member: H.O.NO. is the LAST digits of the member number (23132 -> 130023132, the prefix
 *                      13 is the end of the CODE column, e.g. COPN013); MS.NO. is the full member number
 *   PS.NO.             the member's employee number (member_master.pfno). It is NOT used to find a member (it is not
 *                      unique); it is only compared and recorded in the import log (ES-588)
 *   NAME               compared with the member's name, never used to find the member (names repeat)
 *   TOTAL              must equal the sum of every amount column below
 *   F/D | R/D | RD/CD  the member's RD/CD deposit (the old process called it F/D). Saved to cd_amount, like the
 *                      migrated rows; RD and CD are one deposit
 *   R/LOAN             regular loan principal  (rln_installment_amount)
 *   E/LOAN             emergency loan principal = ALN (aln_installment_amount), not ELN
 *   INTT               loan interest; goes with the regular loan, or with the emergency loan when the row has no
 *                      regular loan amount (the Loan Position notices read it that way)
 *   F.R.S.-1 | MD      FRS1 = MD  (md_amount,  head L1002)
 *   F.R.S.-2 | MD1     FRS2 = MD1 (md1_amount, head L1045)
 *
 * Period handling: the file's own YYMM column is only compared with the month the operator selected (a difference is
 * a warning, never an error: a payroll file may be renamed or imported late). The DB's demand_for_month/year always
 * come from the selected Month/Year.
 */

// every name is written in its normalized form (see normalizeHeader): upper case, no dots, spaces, slashes, dashes
const HEADER_ALIASES: Record<string, string[]> = {
    serialNo: ['SNO'],
    yymm: ['YYMM'],
    code: ['CODE'],
    mbno: ['MSNO'],
    hono: ['HONO'],
    psNo: ['PSNO'],
    name: ['NAME'],
    total: ['TOTAL'],
    cd: ['RD', 'RDCD', 'FD', 'CD'],
    rln: ['RLOAN', 'REGULARLOAN'],
    aln: ['ELOAN', 'EMERGENCYLOAN'],
    intt: ['INTT', 'INTEREST'],
    md: ['FRS1', 'MD'],
    md1: ['FRS2', 'MD1'],
};

function normalizeHeader(raw: string): string {
    return String(raw || '').trim().toUpperCase().replace(/[.\s/\-_]/g, '');
}

/** every column of the sheet that carries this field */
function findColumnKeys(headerRow: string[], field: string): number[] {
    const aliases = HEADER_ALIASES[field].map(normalizeHeader);
    const found: number[] = [];
    headerRow.forEach((h, i) => { if (aliases.includes(normalizeHeader(h))) found.push(i); });
    return found;
}

const normName = (s: any) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** the member name as one string (first, middle, last) */
const MEMBER_NAME_SQL = `REGEXP_REPLACE(TRIM(COALESCE(f_name,'') || ' ' || COALESCE(m_name,'') || ' ' || COALESCE(l_name,'')), '\\s+', ' ', 'g')`;

/** YYMM cell -> year and month. 202610 and 2610 both mean October 2026. */
function parseYymm(v: any): { y: number; m: number } | null {
    const s = String(v ?? '').replace(/\D/g, '');
    let y: number; let m: number;
    if (s.length === 6) { y = Number(s.slice(0, 4)); m = Number(s.slice(4)); }
    else if (s.length === 4) { y = 2000 + Number(s.slice(0, 2)); m = Number(s.slice(2)); }
    else return null;
    return m >= 1 && m <= 12 ? { y, m } : null;
}

export type MemberMatchMethod = 'MEMBER_NO' | 'HONO' | 'MANUAL';

/** ES-591: the Modify Business Rules setting RULE_DEMAND_IMPORT_STRICTNESS. STRICT = any problem and nothing is saved. */
export type ImportStrictness = 'STRICT' | 'STANDARD';
export const IMPORT_STRICTNESS_KEY = 'RULE_DEMAND_IMPORT_STRICTNESS';

export interface MemberSuggestion { memberNo: string; name: string; officeno: string }

export interface DemandImportPreviewRow {
    key: string;
    /** sheet row number (the header is row 1) */
    rowNo?: number;
    memberId: string;
    memberName: string;
    department: string;
    rlnAmount: number;
    alnAmount: number;
    /** F/D, R/D or RD/CD column: the member's RD/CD deposit, saved to cd_amount */
    cdAmount: number;
    /** F.R.S.-1 = MD */
    mdAmount: number;
    /** F.R.S.-2 = MD1 */
    md1Amount: number;
    interest: number;
    totalDemand: number;
    fileTotal: number;
    status: 'Valid' | 'Error';
    remarks: string;
    /** what the file said, kept for the import log */
    honoGiven?: string;
    /** the full member number the file gave (MS.NO.), when it had one */
    memberNoGiven?: string;
    /** the prefix taken from the end of the CODE column; the server needs it to find the member again when saving */
    codePrefix?: string;
    psNo?: string;
    nameInFile?: string;
    /** how the member was found. MANUAL = picked by the operator from the suggestions. */
    matchMethod?: MemberMatchMethod;
    /** shown to the operator (name differs, PS.NO. differs, no PS.NO. on record ...); they only block a save in STRICT mode when listed in strictIssues */
    warnings?: string[];
    /** the warnings that are real differences (name or PS.NO. differs from the member's); they block the import in STRICT mode */
    strictIssues?: string[];
    /** up to 5 members with a similar name, offered when the member could not be found */
    suggestions?: MemberSuggestion[];
    /** "Check this" flags (possible old-EMI / new-EMI mix-up) — see loan-payment-flag.service.ts. Never blocks a save. */
    flags?: LoanPaymentFlag[];
}

export interface DemandImportPreviewResult {
    sheetName: string;
    availableSheets: string[];
    totalRows: number;
    validCount: number;
    errorCount: number;
    flaggedCount: number;
    columnsDetected: string[];
    rows: DemandImportPreviewRow[];
    /** file-level notices, e.g. the file's month differs from the selected month */
    warnings: string[];
    matchedBy: { MEMBER_NO: number; HONO: number };
    /** the strictness the Business Rules ask for right now (read at every import) */
    strictness: ImportStrictness;
}

export interface DemandImportSaveOptions { fileName?: string; savedBy?: string }

export interface DemandImportSaveResult {
    saved: number;
    skipped: number;
    flagged: number;
    batchId: string;
    skippedDetails: Array<{ rowNo?: number; memberId: string; reason: string }>;
    /** the strictness that was applied to this import */
    strictness: ImportStrictness;
}

/** ES-591: thrown inside the import transaction when STRICT mode finds any problem; the transaction is rolled back. */
class ImportRefusedError extends Error {
    constructor(
        public readonly problems: Array<{ rowNo?: number; memberId: string; reason: string }>,
        public readonly batchId: string,
    ) {
        super(`Import refused: ${problems.length} problem(s)`);
    }
}

@Injectable()
export class DemandImportService implements OnModuleInit {
    private readonly logger = new Logger(DemandImportService.name);

    // Built from the DataSource (not injected) — same reason as in LoanRepaymentService.
    private readonly flagService: LoanPaymentFlagService;

    constructor(private readonly dataSource: DataSource) {
        this.flagService = new LoanPaymentFlagService(dataSource);
    }

    /** ES-588: one record per file row (same statement as database/migrations/add-demand-import-log.sql). */
    async onModuleInit(): Promise<void> {
        try {
            await this.dataSource.query(
                `CREATE TABLE IF NOT EXISTS demand_import_log (
                    id bigserial PRIMARY KEY,
                    batch_id uuid NOT NULL,
                    file_name text,
                    row_no integer,
                    demand_month integer NOT NULL,
                    demand_year integer NOT NULL,
                    branch text,
                    member_no_given text,
                    hono text,
                    ps_no text,
                    name_in_file text,
                    member_no text,
                    match_method text,
                    result text NOT NULL,
                    reason text,
                    warnings text,
                    saved_by text,
                    saved_at timestamptz NOT NULL DEFAULT now()
                )`,
            );
            await this.dataSource.query(`CREATE INDEX IF NOT EXISTS idx_demand_import_log_period ON demand_import_log (demand_year, demand_month, member_no)`);
            await this.dataSource.query(`CREATE INDEX IF NOT EXISTS idx_demand_import_log_batch ON demand_import_log (batch_id)`);
        } catch (error: any) {
            this.logger.error(`Could not create demand_import_log: ${error.message}`);
        }
    }

    /** The loan columns of a file row, as (loan type, principal, interest) pairs the flag rules understand.
     *  The file has ONE INTT column, so it is only assigned to a loan type when that is unambiguous
     *  (same rule saveRows uses to split it into rln_interest / aln_interest). */
    private loanItems(row: DemandImportPreviewRow): Array<{ mbno: string; loantype: 'RLN' | 'ALN'; principal: number; interest: number }> {
        const items: Array<{ mbno: string; loantype: 'RLN' | 'ALN'; principal: number; interest: number }> = [];
        if (row.rlnAmount > 0) items.push({ mbno: String(row.memberId), loantype: 'RLN', principal: row.rlnAmount, interest: row.interest });
        if (row.alnAmount > 0 && row.rlnAmount <= 0) items.push({ mbno: String(row.memberId), loantype: 'ALN', principal: row.alnAmount, interest: row.interest });
        return items;
    }

    /** ES-591: the strictness from Modify Business Rules, read at every import. A missing, unreadable or unknown
     *  value means STRICT (when in doubt nothing is saved). */
    async getStrictness(runner: { query: (sql: string, params?: any[]) => Promise<any> } = this.dataSource): Promise<ImportStrictness> {
        try {
            const rows = await runner.query(
                `SELECT value FROM system_configs WHERE key = $1 AND "isActive" IS NOT FALSE ORDER BY id DESC LIMIT 1`,
                [IMPORT_STRICTNESS_KEY],
            );
            return String(rows?.[0]?.value ?? '').trim().toUpperCase() === 'STANDARD' ? 'STANDARD' : 'STRICT';
        } catch (error: any) {
            this.logger.error(`Could not read ${IMPORT_STRICTNESS_KEY}, using STRICT: ${error.message}`);
            return 'STRICT';
        }
    }

    /** The name and PS.NO. never decide who the member is; they only tell the operator when something looks off.
     *  strictIssues are the real differences (they block the import in STRICT mode); the rest is information. */
    private compareNameAndPs(member: any, nameInFile: string, psNo: string): { warnings: string[]; strictIssues: string[] } {
        const warnings: string[] = [];
        const strictIssues: string[] = [];
        if (nameInFile && normName(member.name)) {
            const a = normName(nameInFile); const b = normName(member.name);
            if (a !== b && !a.includes(b) && !b.includes(a)) {
                strictIssues.push(`Name in file "${nameInFile}" differs from the member's name "${member.name}"`);
            }
        }
        const pf = String(member.pfno ?? '').trim();
        if (psNo && pf && pf !== psNo) strictIssues.push(`PS.NO. in file ${psNo} differs from the member's PS.NO. ${pf}`);
        warnings.push(...strictIssues);
        if (psNo && !pf) warnings.push(`The member has no PS.NO. on record; the file has ${psNo}`);
        return { warnings, strictIssues };
    }

    /** Up to 5 members whose name looks like the name in the file, best match first: the same full name, then the
     *  most words in common (never picked automatically; the operator decides). */
    private async findSuggestions(nameInFile: string, branch?: string): Promise<MemberSuggestion[]> {
        const words = String(nameInFile || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
        if (words.length === 0) return [];
        const params: any[] = [words.map((w) => `%${w}%`), normName(nameInFile)];
        let branchCond = '';
        if (branch) { params.push(String(branch)); branchCond = `AND CAST(officeno AS text) = $3`; }
        const rows = await this.dataSource.query(
            `SELECT mbno, officeno, name FROM (
                 SELECT mbno, officeno, ${MEMBER_NAME_SQL} AS name FROM member_master WHERE true ${branchCond}
             ) m
              WHERE UPPER(m.name) LIKE ANY($1::text[])
              ORDER BY (REGEXP_REPLACE(UPPER(m.name), '[^A-Z0-9]', '', 'g') = $2) DESC,
                       (SELECT count(*) FROM unnest($1::text[]) p WHERE UPPER(m.name) LIKE p) DESC,
                       m.mbno
              LIMIT 5`,
            params,
        );
        return (rows || []).map((m: any) => ({ memberNo: String(m.mbno), name: String(m.name || ''), officeno: String(m.officeno ?? '') }));
    }

    /** ES-587: pick the one member a H.O.NO. belongs to, or say why it cannot be done safely. */
    private resolveByHono(
        candidates: any[],
        ctx: { hono: string; prefix: string; branch?: string; psNo: string; name: string },
    ): { member?: any; reason?: string } {
        let c = candidates;
        // the CODE column ends with the member-number prefix (COPN013 -> 13)
        if (ctx.prefix) {
            const byPrefix = c.filter((m) => String(m.mbno).startsWith(ctx.prefix));
            // never fall back to a member of another prefix: that would be a guess with money attached
            if (byPrefix.length === 0 && c.length > 0) {
                return {
                    reason: `H.O.NO. ${ctx.hono} belongs only to member(s) ${c.slice(0, 3).map((m) => m.mbno).join(', ')}, but the CODE column says the member number starts with ${ctx.prefix}`,
                };
            }
            c = byPrefix;
        }
        if (c.length > 1 && ctx.branch) {
            const byBranch = c.filter((m) => String(m.officeno) === String(ctx.branch));
            if (byBranch.length > 0) c = byBranch;
        }
        if (c.length > 1 && ctx.psNo) {
            const byPs = c.filter((m) => String(m.pfno ?? '').trim() === ctx.psNo);
            if (byPs.length === 1) c = byPs;
        }
        if (c.length > 1 && ctx.name) {
            const byName = c.filter((m) => normName(m.name) === normName(ctx.name));
            if (byName.length === 1) c = byName;
        }
        if (c.length === 1) return { member: c[0] };
        if (c.length === 0) return { reason: `No member found for H.O.NO. ${ctx.hono}` };
        return { reason: `H.O.NO. ${ctx.hono} fits ${c.length} members (${c.slice(0, 5).map((m) => m.mbno).join(', ')}); pick the right one by hand` };
    }

    async previewFromBuffer(buffer: Buffer, requestedBranch?: string, month?: number, year?: number): Promise<DemandImportPreviewResult> {
        let workbook: XLSX.WorkBook;
        try {
            workbook = XLSX.read(buffer, { type: 'buffer' });
        } catch (error: any) {
            throw new BadRequestException(`Could not read the uploaded file: ${error.message}`);
        }

        const availableSheets = workbook.SheetNames;
        if (availableSheets.length === 0) {
            throw new BadRequestException('The uploaded file has no sheets.');
        }

        // Sheet selection: prefer a sheet whose name mentions the requested
        // branch, but NEVER silently fall back to an unrelated sheet without
        // telling the caller which one was actually used — always returns
        // sheetName + the full availableSheets list so a wrong guess is
        // visible, not hidden (a real bug already found and fixed elsewhere
        // in this codebase for exactly this reason).
        let sheetName = availableSheets[0];
        if (requestedBranch) {
            const match = availableSheets.find((s) =>
                s.toUpperCase().includes(requestedBranch.toUpperCase()),
            );
            if (match) sheetName = match;
        }

        const sheet = workbook.Sheets[sheetName];
        const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (rawRows.length < 2) {
            throw new BadRequestException(`Sheet "${sheetName}" has no data rows below its header.`);
        }

        const headerRow: string[] = rawRows[0].map((h: any) => String(h ?? ''));
        const col = (field: string) => findColumnKeys(headerRow, field);
        const colIdx = {
            mbno: col('mbno')[0] ?? -1,
            hono: col('hono')[0] ?? -1,
            psNo: col('psNo')[0] ?? -1,
            code: col('code')[0] ?? -1,
            yymm: col('yymm')[0] ?? -1,
            name: col('name')[0] ?? -1,
            total: col('total')[0] ?? -1,
            cd: col('cd'),
            md: col('md'),
            md1: col('md1'),
            rln: col('rln'),
            aln: col('aln'),
            intt: col('intt'),
        };

        if (colIdx.mbno === -1 && colIdx.hono === -1) {
            throw new BadRequestException(
                `Could not find a member column (expected "H.O.NO." or "MS.NO.") in sheet "${sheetName}". ` +
                `Columns found: ${headerRow.filter(Boolean).join(', ') || '(none)'}`,
            );
        }

        const dataRows = rawRows.slice(1)
            .map((r, i) => ({ r, rowNo: i + 2 }))
            .filter(({ r }) => r.some((cell) => cell !== '' && cell !== null && cell !== undefined));

        const cell = (r: any[], idx: number) => (idx === -1 ? '' : String(r[idx] ?? '').trim());

        // ---- members the file points at -------------------------------------------------------------------
        const fullNos = dataRows.map(({ r }) => cell(r, colIdx.mbno)).filter(Boolean);
        const realMembers = fullNos.length > 0
            ? await this.dataSource.query(
                `SELECT mbno, officeno, dept_name, pfno, ${MEMBER_NAME_SQL} as name
                 FROM member_master WHERE CAST(mbno AS text) = ANY($1)`,
                [fullNos],
            )
            : [];
        const memberByNo = new Map<string, any>(realMembers.map((m: any) => [String(m.mbno), m]));

        // H.O.NO. rows (the row has no full member number): every member whose last digits are that number
        const honoTails = new Map<number, Set<string>>(); // digit count -> tails
        for (const { r } of dataRows) {
            if (cell(r, colIdx.mbno)) continue;
            const h = cell(r, colIdx.hono);
            if (!/^\d{1,9}$/.test(h)) continue;
            if (!honoTails.has(h.length)) honoTails.set(h.length, new Set());
            honoTails.get(h.length)!.add(String(Number(h)));
        }
        const candidatesByHono = new Map<string, any[]>(); // "len:tail" -> members
        for (const [len, tails] of honoTails) {
            const found = await this.dataSource.query(
                `SELECT mbno, officeno, dept_name, pfno, ${MEMBER_NAME_SQL} as name
                   FROM member_master
                  WHERE CAST(mbno AS numeric) % CAST($1 AS numeric) = ANY($2::numeric[])`,
                [String(10 ** len), [...tails]],
            );
            for (const m of found || []) {
                const key = `${len}:${Number(m.mbno) % 10 ** len}`;
                if (!candidatesByHono.has(key)) candidatesByHono.set(key, []);
                candidatesByHono.get(key)!.push(m);
            }
        }

        const num = (v: any, label: string, remarks: string[]): number => {
            const raw = String(v ?? '').trim();
            if (!raw) return 0;
            const n = Number(raw.replace(/,/g, ''));
            if (!Number.isFinite(n) || n < 0) {
                remarks.push(`${label} must be a non-negative number`);
                return 0;
            }
            return Math.round(n * 100) / 100;
        };
        const sumCols = (r: any[], idxs: number[], label: string, remarks: string[]) =>
            Math.round(idxs.reduce((s, i) => s + num(r[i], label, remarks), 0) * 100) / 100;

        const matchedBy = { MEMBER_NO: 0, HONO: 0 };
        let suggestionLookups = 0;
        const seenMemberNos = new Set<string>();
        const fileMonths = new Set<string>();
        const rows: DemandImportPreviewRow[] = [];

        for (const { r, rowNo } of dataRows) {
            const remarks: string[] = [];
            const warnings: string[] = [];
            const fullNo = cell(r, colIdx.mbno);
            const honoGiven = cell(r, colIdx.hono);
            const psNo = cell(r, colIdx.psNo);
            const nameInFile = cell(r, colIdx.name).replace(/\s+/g, ' ');

            const rlnAmount = sumCols(r, colIdx.rln, 'R/LOAN', remarks);
            const alnAmount = sumCols(r, colIdx.aln, 'E/LOAN', remarks);
            const cdAmount = sumCols(r, colIdx.cd, 'F/D (R/D)', remarks);
            const mdAmount = sumCols(r, colIdx.md, 'F.R.S.-1', remarks);
            const md1Amount = sumCols(r, colIdx.md1, 'F.R.S.-2', remarks);
            const interest = sumCols(r, colIdx.intt, 'INTT', remarks);
            const fileTotal = colIdx.total !== -1 ? num(r[colIdx.total], 'TOTAL', remarks) : 0;
            const computedTotal = Math.round((rlnAmount + alnAmount + cdAmount + mdAmount + md1Amount + interest) * 100) / 100;

            const yymm = parseYymm(cell(r, colIdx.yymm));
            if (yymm) fileMonths.add(`${yymm.y}-${String(yymm.m).padStart(2, '0')}`);

            // ---- find the member ----
            // the CODE column ends with the member-number prefix (COPN013 -> 13)
            const codePrefix = (cell(r, colIdx.code).match(/(\d+)\s*$/)?.[1] ?? '').slice(-2);
            let member: any;
            let matchMethod: MemberMatchMethod | undefined;
            let notFoundReason = '';
            let strictIssues: string[] = [];
            if (fullNo) {
                member = memberByNo.get(fullNo);
                matchMethod = 'MEMBER_NO';
                if (!member) notFoundReason = `Member ${fullNo} not found`;
            } else if (honoGiven) {
                if (!/^\d{1,9}$/.test(honoGiven)) {
                    notFoundReason = `H.O.NO. "${honoGiven}" must be digits only`;
                } else {
                    const cands = candidatesByHono.get(`${honoGiven.length}:${Number(honoGiven)}`) ?? [];
                    const res = this.resolveByHono(cands, { hono: honoGiven, prefix: codePrefix, branch: requestedBranch, psNo, name: nameInFile });
                    member = res.member;
                    matchMethod = 'HONO';
                    if (!member) notFoundReason = res.reason || `Member not found for H.O.NO. ${honoGiven}`;
                }
            } else {
                notFoundReason = 'Missing member number';
            }

            let status: 'Valid' | 'Error' = 'Valid';
            let memberId = '';
            let suggestions: MemberSuggestion[] | undefined;
            if (!member) {
                status = 'Error'; remarks.push(notFoundReason);
                matchMethod = undefined;
                if (nameInFile && suggestionLookups < 100) {
                    suggestionLookups++;
                    suggestions = await this.findSuggestions(nameInFile, requestedBranch);
                    if (suggestions.length === 0) suggestions = undefined;
                }
            } else {
                memberId = String(member.mbno);
                if (seenMemberNos.has(memberId)) {
                    status = 'Error'; remarks.push(`Duplicate member ${memberId} in file`);
                } else {
                    seenMemberNos.add(memberId);
                }
                // the name and the PS.NO. never decide who the member is, they only tell the operator if something looks off
                const cmp = this.compareNameAndPs(member, nameInFile, psNo);
                warnings.push(...cmp.warnings);
                strictIssues = cmp.strictIssues;
                if (matchMethod === 'HONO') matchedBy.HONO++; else matchedBy.MEMBER_NO++;
            }
            if (colIdx.total !== -1 && totalsDiffer(computedTotal, fileTotal)) {
                status = 'Error';
                remarks.push(`Row total ₹${computedTotal} doesn't match file's TOTAL ₹${fileTotal}`);
            }
            if (requestedBranch && member && String(member.officeno) !== String(requestedBranch)) {
                status = 'Error';
                remarks.push(`Member belongs to branch ${member.officeno}, not ${requestedBranch}`);
            }

            rows.push({
                key: `${rowNo}-${memberId || honoGiven || fullNo || 'unknown'}`,
                rowNo,
                memberId,
                memberName: member?.name || nameInFile || 'Unknown',
                department: member?.dept_name || 'General',
                rlnAmount, alnAmount, cdAmount, mdAmount, md1Amount, interest,
                totalDemand: computedTotal,
                fileTotal,
                status,
                remarks: remarks.join('; '),
                honoGiven: honoGiven || undefined,
                memberNoGiven: fullNo || undefined,
                codePrefix: codePrefix || undefined,
                psNo: psNo || undefined,
                nameInFile: nameInFile || undefined,
                matchMethod,
                warnings: warnings.length > 0 ? warnings : undefined,
                strictIssues: strictIssues.length > 0 ? strictIssues : undefined,
                suggestions,
            });
        }

        const warnings: string[] = [];
        if (month && year && fileMonths.size > 0) {
            const chosen = `${year}-${String(month).padStart(2, '0')}`;
            if ([...fileMonths].some((m) => m !== chosen)) {
                warnings.push(
                    `The file's YYMM column says ${[...fileMonths].sort().join(', ')} but you selected ${chosen}. ` +
                    `That is fine if it is intended (for example October's payroll received in November); the amounts are saved for ${chosen}.`,
                );
            }
        }

        // Flags need the demand month the operator selected; without it nothing is checked.
        if (month && year) {
            const validRows = rows.filter((r) => r.status === 'Valid');
            const flagMap = await this.flagService.checkDemandRows(this.dataSource, validRows.flatMap((r) => this.loanItems(r)), month, year);
            for (const r of validRows) {
                const found = this.loanItems(r).map((it) => flagMap.get(`${it.mbno}|${it.loantype}`)).filter((f): f is LoanPaymentFlag => !!f);
                if (found.length > 0) r.flags = found;
            }
        }

        return {
            sheetName,
            availableSheets,
            totalRows: rows.length,
            validCount: rows.filter((r) => r.status === 'Valid').length,
            errorCount: rows.filter((r) => r.status === 'Error').length,
            flaggedCount: rows.filter((r) => (r.flags?.length ?? 0) > 0).length,
            columnsDetected: headerRow.filter(Boolean),
            rows,
            warnings,
            matchedBy,
            strictness: await this.getStrictness(),
        };
    }

    /** ES-588: writes the import log rows. In STANDARD mode a log error never fails the import (a savepoint isolates
     *  it); in STRICT mode (mustSucceed) an import without a record is not allowed, so the error is passed on and the
     *  whole import is rolled back (ES-591). */
    private async writeLog(queryRunner: QueryRunner, entries: any[][], mustSucceed = false): Promise<void> {
        if (entries.length === 0) return;
        const COLS = 15;
        try {
            await queryRunner.query('SAVEPOINT demand_import_log');
            for (let i = 0; i < entries.length; i += 200) {
                const chunk = entries.slice(i, i + 200);
                const params: any[] = [];
                const values = chunk.map((e, k) => {
                    params.push(...e);
                    return `(${Array.from({ length: COLS }, (_, j) => `$${k * COLS + j + 1}`).join(',')})`;
                });
                await queryRunner.query(
                    `INSERT INTO demand_import_log
                        (batch_id, file_name, row_no, demand_month, demand_year, branch, member_no_given, hono, ps_no,
                         name_in_file, member_no, match_method, result, reason, saved_by)
                     VALUES ${values.join(',')}`,
                    params,
                );
            }
            await queryRunner.query('RELEASE SAVEPOINT demand_import_log');
        } catch (error: any) {
            this.logger.error(`Could not write demand_import_log: ${error.message}`);
            if (mustSucceed) throw error;
            try { await queryRunner.query('ROLLBACK TO SAVEPOINT demand_import_log'); } catch { /* transaction state is handled by the caller */ }
        }
    }

    /** ES-591: a refused (STRICT) import is still recorded: every row is logged as REFUSED with its own reason, in a
     *  transaction of its own because the import's transaction was rolled back. Best effort: the refusal itself stands. */
    private async logRefusal(queryRunner: QueryRunner, entries: any[][]): Promise<void> {
        try {
            await queryRunner.startTransaction();
            await this.writeLog(queryRunner, entries, true);
            await queryRunner.commitTransaction();
        } catch (error: any) {
            this.logger.error(`Could not record the refused import: ${error.message}`);
            try { await queryRunner.rollbackTransaction(); } catch { /* nothing more to do */ }
        }
    }

    /** ES-591 (STRICT): the server finds the member again itself and never trusts the member number, the way it was
     *  found or the status the screen sent back. Returns the problem, or null when the row checks out. */
    private async recheckRowAsServer(
        runner: { query: (sql: string, params?: any[]) => Promise<any> },
        row: DemandImportPreviewRow,
        branch?: string,
    ): Promise<string | null> {
        const memberRows = await runner.query(
            `SELECT mbno, officeno, pfno, ${MEMBER_NAME_SQL} AS name FROM member_master WHERE CAST(mbno AS text) = $1`,
            [String(row.memberId)],
        );
        const member = memberRows?.[0];
        if (!member) return `Member ${row.memberId} was not found`;

        const method = row.matchMethod ?? 'MEMBER_NO';
        if (method === 'MEMBER_NO') {
            if (String(row.memberNoGiven ?? '') !== String(row.memberId)) {
                return `The member number in the file (${row.memberNoGiven ?? 'none'}) is not ${row.memberId}`;
            }
        } else if (method === 'HONO') {
            const hono = String(row.honoGiven ?? '');
            if (!/^\d{1,9}$/.test(hono)) return `H.O.NO. "${hono}" must be digits only`;
            const found = await runner.query(
                `SELECT mbno, officeno, pfno, ${MEMBER_NAME_SQL} AS name FROM member_master
                  WHERE CAST(mbno AS numeric) % CAST($1 AS numeric) = CAST($2 AS numeric)`,
                [String(10 ** hono.length), String(Number(hono))],
            );
            const res = this.resolveByHono(found || [], { hono, prefix: row.codePrefix ?? '', branch, psNo: String(row.psNo ?? ''), name: String(row.nameInFile ?? '') });
            if (!res.member) return `The server cannot find the member again: ${res.reason}`;
            if (String(res.member.mbno) !== String(row.memberId)) {
                return `The server finds member ${res.member.mbno} for H.O.NO. ${hono}, not ${row.memberId}`;
            }
        } else if (method === 'MANUAL') {
            // picked by hand: only one of the members the server itself would suggest for this row is accepted
            const suggestions = await this.findSuggestions(String(row.nameInFile ?? ''), branch);
            if (!suggestions.some((s) => s.memberNo === String(row.memberId))) {
                return `Member ${row.memberId} is not one of the members the server suggests for this row`;
            }
            return null; // the name differs from the member's by definition, that is why the operator picked
        } else {
            return `Unknown way of finding the member: ${method}`;
        }
        const cmp = this.compareNameAndPs(member, String(row.nameInFile ?? ''), String(row.psNo ?? ''));
        return cmp.strictIssues.length > 0 ? cmp.strictIssues.join('; ') : null;
    }

    /** Persists already-previewed, already-validated rows into demand_master
     *  for the operator-selected month/year (not the file's own YYMM column
     *  — see the class doc comment on why). Every row of the file, saved or
     *  skipped, leaves a record in demand_import_log with the reason (ES-588). */
    async saveRows(
        month: number,
        year: number,
        rows: DemandImportPreviewRow[],
        requestedBranch?: string,
        options: DemandImportSaveOptions = {},
    ): Promise<DemandImportSaveResult> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        let refusalEntries: any[][] = [];
        try {
            // ES-591: read at every import (no restart needed); unknown or missing means STRICT
            const strictness = await this.getStrictness(queryRunner);
            const strict = strictness === 'STRICT';
            // Prevent two concurrent imports from allocating duplicate serials
            // or racing the same period's composite key.
            await queryRunner.query('LOCK TABLE demand_master IN SHARE ROW EXCLUSIVE MODE');
            const nextSerialRows = await queryRunner.query(
                'SELECT COALESCE(MAX(dmnd_srno), 0) + 1 AS next_serial FROM demand_master',
            );
            let nextSerial = Number(nextSerialRows[0]?.next_serial || 1);

            const batchId = randomUUID();
            const logEntries: any[][] = [];
            const skippedDetails: Array<{ rowNo?: number; memberId: string; reason: string }> = [];
            const seenMembers = new Set<string>();
            let saved = 0;
            let skipped = 0;
            const savedRows: DemandImportPreviewRow[] = [];

            const record = (row: DemandImportPreviewRow, result: 'SAVED' | 'SKIPPED', reason: string | null) => {
                if (result === 'SKIPPED') {
                    skipped++;
                    skippedDetails.push({ rowNo: row.rowNo, memberId: String(row.memberId || ''), reason: reason || 'Skipped' });
                }
                logEntries.push([
                    batchId, options.fileName ?? null, row.rowNo ?? null, month, year, requestedBranch ?? null,
                    row.memberId ? String(row.memberId) : null, row.honoGiven ?? null, row.psNo ?? null, row.nameInFile ?? null,
                    row.memberId ? String(row.memberId) : null, row.matchMethod ?? null, result, reason, options.savedBy ?? null,
                ]);
            };

            for (const row of rows) {
                if (row.status !== 'Valid') { record(row, 'SKIPPED', `Error in the preview: ${row.remarks || 'row not valid'}`); continue; }
                if (seenMembers.has(String(row.memberId))) {
                    record(row, 'SKIPPED', `Member ${row.memberId} appears twice in this save`);
                    continue;
                }
                seenMembers.add(String(row.memberId));

                const amounts = [row.totalDemand, row.rlnAmount, row.alnAmount, row.cdAmount, row.mdAmount, row.md1Amount, row.interest];
                if (amounts.some((v) => !Number.isFinite(Number(v)) || Number(v) < 0)) {
                    record(row, 'SKIPPED', 'An amount is not a valid non-negative number');
                    continue;
                }
                const recomputedTotal = Number(row.rlnAmount) + Number(row.alnAmount) + Number(row.cdAmount) +
                    Number(row.mdAmount) + Number(row.md1Amount) + Number(row.interest);
                if (totalsDiffer(recomputedTotal, Number(row.totalDemand))) {
                    record(row, 'SKIPPED', `The parts add up to ₹${recomputedTotal.toFixed(2)} but the total is ₹${Number(row.totalDemand).toFixed(2)}`);
                    continue;
                }
                // ES-591: in STRICT mode the server finds the member again itself instead of trusting the screen
                if (strict) {
                    const problem = await this.recheckRowAsServer(queryRunner, row, requestedBranch);
                    if (problem) { record(row, 'SKIPPED', problem); continue; }
                }

                // officeno is NOT NULL on demand_master — pull the member's
                // real office from member_master rather than guessing a
                // default (confirmed live: omitting it violates the
                // constraint outright, so there's no safe fallback here).
                const officeRows = await queryRunner.query(
                    `SELECT officeno FROM member_master WHERE CAST(mbno AS text) = $1`,
                    [row.memberId],
                );
                const officeno = officeRows[0]?.officeno ?? null;
                if (officeno === null) {
                    record(row, 'SKIPPED', `Member ${row.memberId} was not found`);
                    continue;
                }
                if (requestedBranch && String(officeno) !== String(requestedBranch)) {
                    record(row, 'SKIPPED', `Member belongs to branch ${officeno}, not ${requestedBranch}`);
                    continue;
                }

                const rlnInterest = row.rlnAmount > 0 ? row.interest : 0;
                const alnInterest = row.alnAmount > 0 && row.rlnAmount <= 0 ? row.interest : 0;

                // ES-456: a month that is already posted to the ledger must not be changed by a re-import (the
                // amounts would then disagree with the ledger and nothing would show it). Such rows are skipped.
                const alreadyPosted = await queryRunner.query(
                    `SELECT 1 FROM demand_master WHERE demand_for_month = $1 AND demand_for_year = $2 AND mbno = $3
                       AND demand_posted = 'Y' LIMIT 1`,
                    [month, year, row.memberId],
                );
                if (alreadyPosted.length > 0) {
                    record(row, 'SKIPPED', 'This month is already posted for the member');
                    continue;
                }

                // ES-586: the F/D (R/D) figure is the RD/CD deposit and is saved to cd_amount (like the migrated rows);
                // F.R.S.-1 is MD and F.R.S.-2 is MD1. rd_amount is cleared so the deposit is never counted twice.
                const updated = await queryRunner.query(
                    `UPDATE demand_master SET
                        rln_installment_amount = $3, rln_interest = $4,
                        aln_installment_amount = $5, aln_interest = $6,
                        cd_amount = $7, md_amount = $8, md1_amount = $9, rd_amount = 0,
                        totaldemand = $10, balance_for_month = $10,
                        officeno = $11
                     WHERE demand_for_month = $1 AND demand_for_year = $2 AND mbno = $12
                     RETURNING mbno`,
                    [month, year, row.rlnAmount, rlnInterest, row.alnAmount, alnInterest, row.cdAmount, row.mdAmount, row.md1Amount, row.totalDemand, officeno, row.memberId],
                );
                if (updated[0].length === 0) {
                    // dmnd_srno is NOT NULL with no unique constraint and no
                    // default — legacy rows already use 0 as a placeholder
                    // (see project_demand_recovery_testing notes), matched
                    // here rather than inventing a new convention.
                    await queryRunner.query(
                        `INSERT INTO demand_master (
                            demand_for_month, demand_for_year, mbno, officeno, dmnd_srno,
                            demand_posted, sd, passflag, receipt_vchr_no,
                            rln_installment_amount, rln_interest,
                            aln_installment_amount, aln_interest,
                            rd_amount, cd_amount, md_amount, md1_amount, totaldemand, balance_for_month
                        ) VALUES ($1,$2,$3,$4,$5,'N','N','N','',$6,$7,$8,$9,0,$10,$11,$12,$13,$13)`,
                        [month, year, row.memberId, officeno, nextSerial++, row.rlnAmount, rlnInterest, row.alnAmount, alnInterest, row.cdAmount, row.mdAmount, row.md1Amount, row.totalDemand],
                    );
                }

                // The RD/CD figure of the file is the operator's own record of what
                // the member actually paid this month — per the user's
                // explicit instruction, recorded exactly as given, with NO
                // auto-calculation or validation against the member's
                // configured monthly amount. A blank/zero value means
                // "didn't pay via this import" (possibly paid at the counter
                // instead, or genuinely missed) — nothing is written for it,
                // rather than recording a misleading paid_amount=0 row.
                if (row.cdAmount > 0) {
                    await this.recordRdInstallmentFromImport(queryRunner, row.memberId, month, year, row.cdAmount);
                }
                saved++;
                savedRows.push(row);
                record(row, 'SAVED', null);
            }

            // ES-591 (STRICT): one problem anywhere and NOTHING is saved. Everything written above is rolled back;
            // the refusal is recorded in the import log and the operator gets the list of problems.
            if (strict && skipped > 0) {
                refusalEntries = logEntries.map((e) => {
                    const own = e[12] === 'SKIPPED';
                    return [...e.slice(0, 12), 'REFUSED', own ? e[13] : 'Not saved: the whole file was refused because another row has a problem (STRICT)', e[14]];
                });
                throw new ImportRefusedError(skippedDetails, batchId);
            }

            // Re-check on the server (never trust flags sent back by the client) only to report how many rows
            // need checking. Nothing is stored for them: the Loan Position panel works the same notice out
            // again from the saved demand rows. Flags never block or change what was saved above.
            const flagMap = await this.flagService.checkDemandRows(queryRunner, savedRows.flatMap((r) => this.loanItems(r)), month, year);
            const flagged = savedRows.filter((r) => this.loanItems(r).some((it) => flagMap.has(`${it.mbno}|${it.loantype}`))).length;
            await this.writeLog(queryRunner, logEntries, strict);
            await queryRunner.commitTransaction();
            return { saved, skipped, flagged, batchId, skippedDetails, strictness };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            if (error instanceof ImportRefusedError) {
                await this.logRefusal(queryRunner, refusalEntries);
                const shown = error.problems.slice(0, 15).map((p) => `• Row ${p.rowNo ?? '?'}${p.memberId ? ` (member ${p.memberId})` : ''}: ${p.reason}`).join('\n');
                throw new BadRequestException({
                    message: `Import refused (strictness STRICT): ${error.problems.length} problem(s), nothing was saved.\n${shown}` +
                        (error.problems.length > 15 ? `\n• ... and ${error.problems.length - 15} more (all are in the import log)` : ''),
                    problems: error.problems.slice(0, 100),
                    batchId: error.batchId,
                });
            }
            this.logger.error('Demand import save failed', error);
            throw new Error('Failed to save imported demand: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /** Writes one member's RD/CD figure into rd_installment_ledger as a
     *  PAID installment for the given calendar month/year — the amount is
     *  used exactly as given (no auto-calculation), matching the user's
     *  explicit instruction that the operator's Excel figure is the source
     *  of truth. Upserts so re-importing a corrected file for the same
     *  month updates rather than duplicates. */
    private async recordRdInstallmentFromImport(
        queryRunner: QueryRunner,
        mbno: string,
        month: number,
        year: number,
        amount: number,
    ): Promise<void> {
        const dueDate = new Date(year, month - 1, 5);

        const yearRows = await queryRunner.query(
            `SELECT yearcode FROM yearend WHERE start_date <= $1 AND end_date >= $1 LIMIT 1`,
            [dueDate],
        );
        if (!yearRows[0]) {
            this.logger.warn(`No financial year found covering ${month}/${year} — RD installment for member ${mbno} was NOT recorded`);
            return;
        }
        const yearcode = yearRows[0].yearcode;

        // expected_amount is informational (used by the pattern engine to
        // judge on-time vs. shortfall) — it comes from the member's
        // configured monthly amount, never from this import. If nothing is
        // configured yet, the paid amount stands in for it so an
        // unconfigured member is never unfairly flagged as underpaid.
        const configRows = await queryRunner.query(
            `SELECT monthly_rd_amount FROM rd_member_config
             WHERE mbno = $1 AND yearcode = $2 AND effective_from_date <= $3
             ORDER BY effective_from_date DESC, id DESC LIMIT 1`,
            [mbno, yearcode, dueDate],
        );
        const expectedAmount = configRows[0] ? Number(configRows[0].monthly_rd_amount) : amount;

        // ES-574: a member whose RD/CD arrives through the monthly demand and who has no monthly amount for this
        // financial year gets one now, from this first amount, effective from this month. An amount that is already set
        // (even one that starts in a later month) is never changed by an import.
        if (!configRows[0]) {
            const anyConfig = await queryRunner.query(
                `SELECT 1 FROM rd_member_config WHERE mbno = $1 AND yearcode = $2 LIMIT 1`,
                [mbno, yearcode],
            );
            if (anyConfig.length === 0) {
                await queryRunner.query(
                    `INSERT INTO rd_member_config (mbno, yearcode, monthly_rd_amount, effective_from_date, set_by)
                     VALUES ($1, $2, $3, $4::date, 'DEMAND IMPORT')`,
                    [mbno, yearcode, amount, `${year}-${String(month).padStart(2, '0')}-01`],
                );
            }
        }

        // due_date/paid_date are DATE columns — pass 'YYYY-MM-DD' strings,
        // never the raw Date object (node-postgres serializes a JS Date
        // into a date column via UTC components, silently losing a day for
        // any positive UTC offset — the same bug already found and fixed in
        // rd-balance-events.service.ts's appendEvent()).
        const dueDateStr = toDateOnlyString(dueDate);
        await queryRunner.query(
            `INSERT INTO rd_installment_ledger
                (mbno, yearcode, installment_month, installment_year, due_date, expected_amount, paid_amount, paid_date, is_arrear_clearance, narration)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $5, false, 'Collected via demand import')
             ON CONFLICT (mbno, yearcode, installment_month, installment_year) DO UPDATE SET
                paid_amount = EXCLUDED.paid_amount,
                paid_date = EXCLUDED.paid_date,
                narration = EXCLUDED.narration`,
            [mbno, yearcode, month, year, dueDateStr, expectedAmount, amount],
        );
    }
}
