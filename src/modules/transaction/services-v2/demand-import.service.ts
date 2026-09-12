import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import * as XLSX from 'xlsx';
import { toDateOnlyString } from '../../rd/rd-date-math';

/**
 * Real Excel/CSV parsing for "Import Demand List" — replaces the previous
 * implementation, which never actually read the uploaded file at all
 * (confirmed live: uploading a file containing the literal text "test"
 * returned a "successful" preview of 15 real members with fully random
 * demand amounts, unrelated to anything in the file). No spreadsheet
 * library was even installed in this backend before this.
 *
 * Expected column layout, per the frontend's own long-standing hint
 * (renamed F/D -> R/D on the user's instruction — same column, F/D was
 * always meant to be the RD/CD-shared "R/D" figure, not two different
 * things):
 *   S.NO. | YYMM | CODE | MS.NO. | PS.NO. | NAME | TOTAL | R/D | R/LOAN | E/LOAN | INTT
 *
 * Column -> demand_master mapping (confirmed against this app's real loan
 * type codes, NOT the file's plain-English labels — "E/LOAN" means
 * "Emergency Loan" in the file, which this app codes as ALN, not ELN; see
 * the RLN/ALN/ELN mapping established throughout this session):
 *   MS.NO.  -> mbno (matched against member_master, real member required)
 *   R/LOAN  -> rln_installment_amount (+ rln_interest, from INTT, if this
 *              is the loan column that's actually populated on the row)
 *   E/LOAN  -> aln_installment_amount (+ aln_interest, from INTT) — NOT
 *              eln_*, despite the visual similarity to "E/LOAN"
 *   R/D     -> rd_amount (the new RD system's monthly figure — same
 *              column CD used to occupy before RD existed as its own
 *              concept; see the RD/CD-are-the-same-account decision)
 *   TOTAL   -> totaldemand (used for validation cross-check, not blindly
 *              trusted — a row whose components don't sum to TOTAL is
 *              flagged, not silently accepted)
 *
 * KNOWN GAP, flagged rather than guessed: this column list has no explicit
 * CD figure of its own — R/D occupies the slot CD used to informally sit
 * in before RD/CD were separated as concepts. If a member's real CD
 * deduction is meant to come from this same file under some other
 * heading, that mapping still needs to be confirmed; cd_amount is left
 * untouched by this import until then.
 *
 * Period handling: the file's own YYMM column is used only for display
 * (which period the file itself claims to be for) — the DB's
 * demand_for_month/demand_for_year always come from whatever Month/Year
 * the operator has selected in the UI at Save time, matching this
 * screen's already-established, previously-confirmed convention (flagged,
 * not silently changed, in an earlier session).
 */

const HEADER_ALIASES: Record<string, string[]> = {
    serialNo: ['SNO', 'S.NO', 'SNO.'],
    yymm: ['YYMM'],
    code: ['CODE'],
    mbno: ['MSNO', 'MS.NO', 'MSNO.'],
    psNo: ['PSNO', 'PS.NO', 'PSNO.'],
    name: ['NAME'],
    total: ['TOTAL'],
    rd: ['RD', 'R/D', 'FD', 'F/D'], // F/D accepted too — same column, old name
    rln: ['RLOAN', 'R/LOAN', 'REGULARLOAN'],
    aln: ['ELOAN', 'E/LOAN', 'EMERGENCYLOAN'], // "E/LOAN" = Emergency = ALN, not ELN
    intt: ['INTT', 'INTEREST'],
};

function normalizeHeader(raw: string): string {
    return String(raw || '').trim().toUpperCase().replace(/[.\s/]/g, '');
}

function findColumnKey(headerRow: string[], field: string): number {
    const aliases = HEADER_ALIASES[field].map(normalizeHeader);
    return headerRow.findIndex((h) => aliases.includes(normalizeHeader(h)));
}

export interface DemandImportPreviewRow {
    key: string;
    memberId: string;
    memberName: string;
    department: string;
    rlnAmount: number;
    alnAmount: number;
    rdAmount: number;
    interest: number;
    totalDemand: number;
    fileTotal: number;
    status: 'Valid' | 'Error';
    remarks: string;
}

export interface DemandImportPreviewResult {
    sheetName: string;
    availableSheets: string[];
    totalRows: number;
    validCount: number;
    errorCount: number;
    columnsDetected: string[];
    rows: DemandImportPreviewRow[];
}

@Injectable()
export class DemandImportService {
    private readonly logger = new Logger(DemandImportService.name);

    constructor(private readonly dataSource: DataSource) { }

    async previewFromBuffer(buffer: Buffer, requestedBranch?: string): Promise<DemandImportPreviewResult> {
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
        const colIdx = {
            mbno: findColumnKey(headerRow, 'mbno'),
            name: findColumnKey(headerRow, 'name'),
            total: findColumnKey(headerRow, 'total'),
            rd: findColumnKey(headerRow, 'rd'),
            rln: findColumnKey(headerRow, 'rln'),
            aln: findColumnKey(headerRow, 'aln'),
            intt: findColumnKey(headerRow, 'intt'),
        };

        if (colIdx.mbno === -1) {
            throw new BadRequestException(
                `Could not find a member-number column (expected "MS.NO.") in sheet "${sheetName}". ` +
                `Columns found: ${headerRow.filter(Boolean).join(', ') || '(none)'}`,
            );
        }

        const dataRows = rawRows.slice(1).filter((r) => r.some((cell) => cell !== '' && cell !== null && cell !== undefined));
        const memberNos = dataRows
            .map((r) => String(r[colIdx.mbno] ?? '').trim())
            .filter(Boolean);

        const realMembers = memberNos.length > 0
            ? await this.dataSource.query(
                `SELECT mbno, TRIM(COALESCE(f_name,'') || ' ' || COALESCE(l_name,'')) as name
                 FROM member_master WHERE CAST(mbno AS text) = ANY($1)`,
                [memberNos],
            )
            : [];
        const memberNameByNo = new Map<string, string>(realMembers.map((m: any) => [String(m.mbno), m.name]));

        const num = (v: any): number => {
            const n = parseFloat(String(v ?? '').replace(/,/g, ''));
            return Number.isFinite(n) ? n : 0;
        };

        const rows: DemandImportPreviewRow[] = dataRows.map((r, idx) => {
            const mbno = String(r[colIdx.mbno] ?? '').trim();
            const rlnAmount = colIdx.rln !== -1 ? num(r[colIdx.rln]) : 0;
            const alnAmount = colIdx.aln !== -1 ? num(r[colIdx.aln]) : 0;
            const rdAmount = colIdx.rd !== -1 ? num(r[colIdx.rd]) : 0;
            const interest = colIdx.intt !== -1 ? num(r[colIdx.intt]) : 0;
            const fileTotal = colIdx.total !== -1 ? num(r[colIdx.total]) : 0;
            const computedTotal = Math.round((rlnAmount + alnAmount + rdAmount + interest) * 100) / 100;

            const realName = memberNameByNo.get(mbno);
            const remarks: string[] = [];
            let status: 'Valid' | 'Error' = 'Valid';

            if (!mbno) {
                status = 'Error'; remarks.push('Missing member number');
            } else if (!realName) {
                status = 'Error'; remarks.push(`Member ${mbno} not found`);
            }
            if (colIdx.total !== -1 && Math.abs(computedTotal - fileTotal) > 1) {
                remarks.push(`Row total ₹${computedTotal} doesn't match file's TOTAL ₹${fileTotal}`);
            }

            return {
                key: `${idx}-${mbno || 'unknown'}`,
                memberId: mbno,
                memberName: realName || (r[colIdx.name] ? String(r[colIdx.name]) : 'Unknown'),
                department: 'General',
                rlnAmount, alnAmount, rdAmount, interest,
                totalDemand: computedTotal,
                fileTotal,
                status,
                remarks: remarks.join('; '),
            };
        });

        return {
            sheetName,
            availableSheets,
            totalRows: rows.length,
            validCount: rows.filter((r) => r.status === 'Valid').length,
            errorCount: rows.filter((r) => r.status === 'Error').length,
            columnsDetected: headerRow.filter(Boolean),
            rows,
        };
    }

    /** Persists already-previewed, already-validated rows into demand_master
     *  for the operator-selected month/year (not the file's own YYMM column
     *  — see the class doc comment on why). */
    async saveRows(
        month: number,
        year: number,
        rows: DemandImportPreviewRow[],
    ): Promise<{ saved: number; skipped: number }> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            let saved = 0;
            let skipped = 0;
            for (const row of rows) {
                if (row.status !== 'Valid') { skipped++; continue; }

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
                    skipped++;
                    continue;
                }

                const rlnInterest = row.rlnAmount > 0 ? row.interest : 0;
                const alnInterest = row.alnAmount > 0 && row.rlnAmount <= 0 ? row.interest : 0;

                const updated = await queryRunner.query(
                    `UPDATE demand_master SET
                        rln_installment_amount = $3, rln_interest = $4,
                        aln_installment_amount = $5, aln_interest = $6,
                        rd_amount = $7,
                        totaldemand = $8, balance_for_month = $8,
                        officeno = $9
                     WHERE demand_for_month = $1 AND demand_for_year = $2 AND mbno = $10
                     RETURNING mbno`,
                    [month, year, row.rlnAmount, rlnInterest, row.alnAmount, alnInterest, row.rdAmount, row.totalDemand, officeno, row.memberId],
                );
                if (updated[0].length === 0) {
                    // dmnd_srno is NOT NULL with no unique constraint and no
                    // default — legacy rows already use 0 as a placeholder
                    // (see project_demand_recovery_testing notes), matched
                    // here rather than inventing a new convention.
                    await queryRunner.query(
                        `INSERT INTO demand_master (
                            demand_for_month, demand_for_year, mbno, officeno, dmnd_srno,
                            rln_installment_amount, rln_interest,
                            aln_installment_amount, aln_interest,
                            rd_amount, totaldemand, balance_for_month
                        ) VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9,$10,$10)`,
                        [month, year, row.memberId, officeno, row.rlnAmount, rlnInterest, row.alnAmount, alnInterest, row.rdAmount, row.totalDemand],
                    );
                }

                // This file's R/D column is the operator's own record of what
                // the member actually paid this month — per the user's
                // explicit instruction, recorded exactly as given, with NO
                // auto-calculation or validation against the member's
                // configured monthly amount. A blank/zero R/D value means
                // "didn't pay via this import" (possibly paid at the counter
                // instead, or genuinely missed) — nothing is written for it,
                // rather than recording a misleading paid_amount=0 row.
                if (row.rdAmount > 0) {
                    await this.recordRdInstallmentFromImport(queryRunner, row.memberId, month, year, row.rdAmount);
                }
                saved++;
            }
            await queryRunner.commitTransaction();
            return { saved, skipped };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Demand import save failed', error);
            throw new Error('Failed to save imported demand: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /** Writes one member's R/D column value into rd_installment_ledger as a
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
