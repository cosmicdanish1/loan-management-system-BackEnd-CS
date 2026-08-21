import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { DemandMaster } from '../entities/demand-master.entity';
import * as XLSX from 'xlsx';

export interface DemandGenerationDto {
    month: string;
    year: string;
    divisionRO: string;
    from?: string;
    to?: string;
}

export interface ParsedDemandRow {
    key: string;
    period: string;
    branch: string;
    memberNo: string;
    personalNo: string;
    memberName: string;
    totalAmount: number;
    rdAmount: number;
    regularLoanAmt: number;
    emergencyLoanAmt: number;
    loanInterest: number;
    frs1Amount: number;
    frs2Amount: number;
    status: 'Valid' | 'Error';
    remarks: string;
}

const MONTH_MAP: Record<string, number> = {
    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12,
    'January': 1, 'February': 2, 'March': 3, 'April': 4, 'May': 5, 'June': 6,
    'July': 7, 'August': 8, 'September': 9, 'October': 10, 'November': 11, 'December': 12,
};

@Injectable()
export class DemandGenerationService {
    private readonly logger = new Logger(DemandGenerationService.name);

    constructor(
        @InjectRepository(DemandMaster)
        private readonly demandRepository: Repository<DemandMaster>,
        private readonly dataSource: DataSource,
    ) { }

    async previewDemandImport(file: any, month: string, year: string, branch?: string): Promise<{
        rows: ParsedDemandRow[];
        summary: { total: number; valid: number; errors: number; sheetName: string; columns: string[] };
        validationErrors: string[];
    }> {
        this.logger.log(`Parsing demand file for ${month} ${year} branch=${branch}`);

        if (!file || !file.buffer) {
            throw new Error('No file uploaded. Please select an Excel (.xls/.xlsx) or CSV file.');
        }

        let workbook: XLSX.WorkBook;
        try {
            workbook = XLSX.read(file.buffer, { type: 'buffer' });
        } catch (e) {
            throw new Error('Cannot read file. Make sure it is a valid Excel (.xls/.xlsx) or CSV file.');
        }

        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
            throw new Error('The uploaded file has no sheets.');
        }

        const validationErrors: string[] = [];

        // Find the right sheet — match by branch name first, then period, then last resort first sheet
        let sheetName = workbook.SheetNames[0];
        const monthNum = MONTH_MAP[month] || 0;
        const periodPattern = `${year}${String(monthNum).padStart(2, '0')}`;

        // Resolve branch name from office_master if branch is a number
        let branchName = '';
        if (branch) {
            const branchResult = await this.dataSource.query(
                `SELECT office_name FROM office_master WHERE officeno = $1`, [parseInt(branch) || 0]
            );
            branchName = (branchResult[0]?.office_name || '').toUpperCase().trim();
        }

        // Priority 1: sheet matching both branch name AND period
        let bestMatch = workbook.SheetNames.find(s => {
            const upper = s.toUpperCase().replace(/\s+/g, '');
            return branchName && upper.includes(branchName.replace(/\s+/g, '')) && upper.includes(periodPattern);
        });

        // Priority 2: sheet matching branch name (latest period)
        if (!bestMatch && branchName) {
            const branchSheets = workbook.SheetNames.filter(s =>
                s.toUpperCase().replace(/\s+/g, '').includes(branchName.replace(/\s+/g, ''))
            );
            if (branchSheets.length > 0) {
                bestMatch = branchSheets[branchSheets.length - 1];
            }
        }

        // Priority 3: sheet matching period only
        if (!bestMatch) {
            bestMatch = workbook.SheetNames.find(s =>
                s.toUpperCase().replace(/\s+/g, '').includes(periodPattern)
            );
        }

        // BUG FIX 43: office staff upload one file per branch per month, with exactly one
        // sheet inside named "<BRANCH><YYMM>" for that month - there's no legitimate reason
        // to guess at a different sheet when the requested branch/period isn't found. The old
        // fallback here silently substituted "the last non-generically-named sheet in the
        // workbook" - which, against a multi-branch archive file, picked an unrelated leftover
        // sheet (confirmed live: a sheet named "H2" full of corrupted scientific-notation
        // values) and imported it as if it were real demand data, with only a soft warning
        // that the UI never surfaced. Refusing loudly is correct here - a single-sheet file
        // still uses that one sheet unconditionally (the `let sheetName = workbook.SheetNames[0]`
        // default above), so this only fires for multi-sheet files where nothing matched.
        if (bestMatch) {
            sheetName = bestMatch;
        } else if (workbook.SheetNames.length > 1) {
            const available = workbook.SheetNames.filter(s => !s.match(/^Sheet\d*$/i));
            throw new Error(
                `No sheet found for branch "${branchName || branch}" and period ${periodPattern}. ` +
                `This file has ${workbook.SheetNames.length} sheets but none match a "<BRANCH>${periodPattern}"-style name. ` +
                `Available sheets: ${(available.length > 0 ? available : workbook.SheetNames).join(', ')}. ` +
                `Check that you selected the correct branch and month for this file.`
            );
        }

        const sheet = workbook.Sheets[sheetName];
        const rawRows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (rawRows.length === 0) {
            throw new Error(`Sheet "${sheetName}" is empty — no data rows found.`);
        }

        // The Excel format has a title row that becomes the column keys,
        // and the real column headers are in the FIRST data row.
        // Detect this by looking for known header values in row 0.
        const firstRow = rawRows[0];
        const firstRowValues = Object.values(firstRow).map(v => String(v).trim().toUpperCase());

        let headerMap: Record<string, string> = {};
        let dataStartIdx = 0;

        const knownHeaders = ['S.NO.', 'YYMM', 'CODE', 'MS.NO.', 'PS.NO.', 'NAME', 'TOTAL', 'F/D', 'R/LOAN', 'E/LOAN', 'INTT.'];
        const isHeaderRow = knownHeaders.some(h => firstRowValues.includes(h));

        if (isHeaderRow) {
            // Row 0 contains actual headers — map __EMPTY_N keys to real names
            const keys = Object.keys(firstRow);
            for (const key of keys) {
                const val = String(firstRow[key]).trim().toUpperCase();
                if (val) headerMap[val] = key;
            }
            dataStartIdx = 1;
            this.logger.log(`Detected header row. Mapped ${Object.keys(headerMap).length} columns: ${JSON.stringify(headerMap)}`);
        } else {
            // Try direct column name matching
            const keys = Object.keys(firstRow);
            for (const key of keys) {
                headerMap[key.toUpperCase()] = key;
            }
        }

        // Resolve column keys with flexible matching
        const resolve = (candidates: string[]): string | null => {
            for (const c of candidates) {
                if (headerMap[c]) return headerMap[c];
            }
            // Partial match
            for (const c of candidates) {
                const entry = Object.entries(headerMap).find(([k]) => k.includes(c) || c.includes(k));
                if (entry) return entry[1];
            }
            return null;
        };

        const colHONo = resolve(['H.O.NO.', 'HONO', 'HO NO', 'H.O. NO', 'HONUM']);
        const colMsNo = resolve(['MS.NO.', 'MS NO', 'MSNO', 'MEMBER NO', 'MEMBERNO', 'MBNO']);
        const colMemberNo = colHONo || colMsNo;
        const colPersonalNo = resolve(['PS.NO.', 'PS NO', 'PSNO', 'PERSONAL NO', 'PERSONALNO', 'PFNO']);
        const colName = resolve(['NAME', 'MEMBER NAME', 'MEMBERNAME']);
        const colTotal = resolve(['TOTAL', 'TOTAL AMOUNT', 'TOTALAMOUNT', 'TOTALAMT']);
        const colRD = resolve(['F/D', 'FD', 'RD', 'RD AMOUNT', 'RDAMOUNT']);
        const colRLoan = resolve(['R/LOAN', 'RLOAN', 'REGULAR LOAN', 'REGULARLOAN', 'RLN']);
        const colELoan = resolve(['E/LOAN', 'ELOAN', 'EMERGENCY LOAN', 'EMERGENCYLOAN', 'ELN', 'ALN']);
        const colIntt = resolve(['INTT.', 'INTT', 'INTEREST', 'LOAN INTEREST', 'LOANINTEREST']);
        const colFrs1 = resolve(['F.R.S.-1', 'FRS-1', 'FRS1', 'IFRS', 'IFRS AMOUNT']);
        const colFrs2 = resolve(['F.R.S.-2', 'FRS-2', 'FRS2', 'FRS 1', 'FRS1 AMOUNT']);
        const colPeriod = resolve(['YYMM', 'PERIOD']);
        const colBranch = resolve(['CODE', 'BRANCH']);

        const detectedCols = [
            colMemberNo && (colHONo ? 'H.O.NO.' : 'MS.NO.'), colPersonalNo && 'PS.NO.', colName && 'NAME',
            colTotal && 'TOTAL', colRD && 'F/D', colRLoan && 'R/LOAN',
            colELoan && 'E/LOAN', colIntt && 'INTT.',
            colFrs1 && 'F.R.S.-1', colFrs2 && 'F.R.S.-2'
        ].filter(Boolean);

        if (!colMemberNo) {
            throw new Error(
                `Cannot find "Member No" column (MS.NO.) in the Excel file.\n\n` +
                `Expected columns: S.NO., YYMM, CODE, MS.NO., PS.NO., NAME, TOTAL, F/D, R/LOAN, E/LOAN, INTT.\n\n` +
                `Found in sheet "${sheetName}": ${Object.values(headerMap).length > 0 ? Object.keys(headerMap).join(', ') : 'No recognizable headers'}\n\n` +
                `Make sure the first row of data has column headers like S.NO., YYMM, CODE, MS.NO., etc.`
            );
        }

        if (!colName) validationErrors.push('Warning: "NAME" column not found — member names will be loaded from database.');
        if (!colTotal) validationErrors.push('Warning: "TOTAL" column not found — total amounts will be 0.');

        // Lookup all member numbers for validation
        // The Excel has short H.O.NO. (e.g. 23132) but DB stores full mbno with division prefix (e.g. 130023132)
        // Full mbno = {2-digit division} + {H.O.NO padded to 7 digits} = 9 digits
        const dataRows = rawRows.slice(dataStartIdx);

        // Get the division code for this branch to reconstruct full mbno
        let divisionCode = '';
        if (branchName) {
            const divResult = await this.dataSource.query(
                `SELECT division FROM office_master WHERE UPPER(office_name) = $1`, [branchName]
            );
            divisionCode = divResult[0]?.division || '';
        }

        const buildFullMbno = (shortNo: string): string => {
            if (!divisionCode || shortNo.length >= 9) return shortNo;
            return divisionCode + shortNo.padStart(7, '0');
        };

        const rawMemberNos = dataRows
            .map(r => String(r[colMemberNo] || '').trim())
            .filter(n => n && !isNaN(Number(n)));

        const fullMbnos = rawMemberNos.map(buildFullMbno);
        const memberLookup: Record<string, any> = {};

        if (fullMbnos.length > 0) {
            const uniqueNos = [...new Set(fullMbnos)].filter(n => !isNaN(Number(n)));
            if (uniqueNos.length > 0) {
                const members = await this.dataSource.query(
                    `SELECT mbno::text, CONCAT(COALESCE(f_name,''), ' ', COALESCE(m_name,''), ' ', COALESCE(l_name,'')) as fullname, pfno, officeno
                     FROM member_master WHERE mbno::text = ANY($1)`,
                    [uniqueNos]
                );
                for (const m of members) memberLookup[m.mbno] = m;
            }
        }

        const periodStr = `${year}${String(monthNum).padStart(2, '0')}`;
        const results: ParsedDemandRow[] = [];

        for (let i = 0; i < dataRows.length; i++) {
            const row = dataRows[i];
            const rawMemberNo = String(row[colMemberNo] || '').trim();

            // Skip empty rows, total rows, header-like rows
            if (!rawMemberNo || isNaN(Number(rawMemberNo))) continue;

            const fullMbno = buildFullMbno(rawMemberNo);
            const num = (col: string | null): number => {
                if (!col) return 0;
                const val = parseFloat(String(row[col] || '0').replace(/[^0-9.-]/g, ''));
                return isNaN(val) ? 0 : val;
            };

            const dbMember = memberLookup[fullMbno];

            const totalAmt = num(colTotal);
            const errors: string[] = [];
            if (!dbMember) errors.push('New member (not in database yet)');
            // BUG FIX 43: status was a hardcoded 'Valid' constant, never reassigned even when
            // errors were pushed - so every row showed "Valid" regardless of whether the member
            // actually existed (confirmed live: 2472/2472 rows marked Valid against a mostly-wiped
            // test DB). Nothing downstream re-checks member existence before saving or posting,
            // so this was the only place that could have caught it before real money moved.
            const status: 'Valid' | 'Error' = errors.length > 0 ? 'Error' : 'Valid';

            const displayMsNo = colMsNo ? String(row[colMsNo] || '').trim() : rawMemberNo;
            const displayHoNo = colHONo ? String(row[colHONo] || '').trim() : rawMemberNo;

            results.push({
                key: `${i}-${fullMbno}`,
                period: colPeriod ? String(row[colPeriod] || periodStr) : periodStr,
                branch: colBranch ? String(row[colBranch] || branch || '') : (branch || ''),
                memberNo: fullMbno,
                personalNo: displayHoNo,
                memberName: colName ? String(row[colName] || '').trim() : (dbMember?.fullname?.trim() || ''),
                totalAmount: totalAmt,
                rdAmount: num(colRD),
                regularLoanAmt: num(colRLoan),
                emergencyLoanAmt: num(colELoan),
                loanInterest: num(colIntt),
                frs1Amount: num(colFrs1),
                frs2Amount: num(colFrs2),
                status,
                remarks: errors.join('; '),
            });
        }

        const valid = results.filter(r => r.status === 'Valid').length;
        const errCount = results.filter(r => r.status === 'Error').length;

        if (errCount > 0) {
            validationErrors.push(`${errCount} record(s) have errors — check the Status column for details.`);
        }

        this.logger.log(`Parsed ${results.length} rows from sheet "${sheetName}". Valid: ${valid}, Errors: ${errCount}`);

        return {
            rows: results,
            summary: {
                total: results.length,
                valid,
                errors: errCount,
                sheetName,
                columns: detectedCols as string[],
            },
            validationErrors,
        };
    }

    async processDemandImport(month: string, year: string, branch: string, data: any[]) {
        this.logger.log(`Saving demand import: ${month} ${year} branch=${branch} records=${data?.length}`);

        if (!data || data.length === 0) {
            return { success: false, message: 'No records to process.' };
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const monthNum = MONTH_MAP[month] || parseInt(month) || 0;
            const yearNum = parseInt(year);
            if (!monthNum || !yearNum) throw new Error(`Invalid month/year: ${month} ${year}`);

            // Get next dmnd_srno
            const maxSrnoResult = await queryRunner.query(
                `SELECT COALESCE(MAX(dmnd_srno), 0) as max_srno FROM demand_master`
            );
            let nextSrno = Number(maxSrnoResult[0]?.max_srno || 0) + 1;

            let saved = 0;
            let skipped = 0;
            for (const record of data) {
                const memberNo = parseInt(record.memberNo);
                if (isNaN(memberNo)) continue;

                const totalAmount = parseFloat(record.totalAmount) || 0;
                const rdAmount = parseFloat(record.rdAmount) || 0;
                const regularLoanAmt = parseFloat(record.regularLoanAmt) || 0;
                const emergencyLoanAmt = parseFloat(record.emergencyLoanAmt) || 0;
                const loanInterest = parseFloat(record.loanInterest) || 0;

                const frs1Amount = parseFloat(record.frs1Amount) || 0;
                const frs2Amount = parseFloat(record.frs2Amount) || 0;

                // Check if record already exists
                const existsResult = await queryRunner.query(
                    `SELECT 1 FROM demand_master WHERE demand_for_month = $1 AND demand_for_year = $2 AND mbno = $3`,
                    [monthNum, yearNum, memberNo]
                );
                if (existsResult.length > 0) {
                    skipped++;
                    continue;
                }

                await queryRunner.query(
                    `INSERT INTO demand_master (
                        dmnd_srno, demand_for_month, demand_for_year, mbno, totaldemand, balance_for_month,
                        rd_amount, rln_installment_amount, eln_installment_amount, rln_interest,
                        md_amount, md1_amount, demand_posted, officeno, dmnd_gnrt_date
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'N', $13, NOW())`,
                    [nextSrno++, monthNum, yearNum, memberNo, totalAmount, totalAmount,
                     rdAmount, regularLoanAmt, emergencyLoanAmt, loanInterest,
                     frs1Amount, frs2Amount,
                     parseInt(branch) || null]
                );
                saved++;
            }

            // Snapshot member balances into the demand record (legacy Pr_MemberHeadBalance equivalent)
            if (saved > 0) {
                const savedMbnos = data
                    .map(r => parseInt(r.memberNo))
                    .filter(n => !isNaN(n));
                await this.snapshotMemberBalances(queryRunner, savedMbnos, monthNum, yearNum);
            }

            await queryRunner.commitTransaction();

            if (skipped > 0 && saved === 0) {
                return {
                    success: false,
                    message: `All ${skipped} records already exist for ${month} ${year}. No new records saved. If you want to re-import, delete the existing demand records first.`,
                    recordCount: 0,
                    skipped,
                };
            }

            return {
                success: true,
                message: `Successfully saved ${saved} demand records for ${month} ${year}` +
                    (skipped > 0 ? `. ${skipped} duplicate(s) skipped.` : ''),
                recordCount: saved,
                skipped,
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('processDemandImport failed', error);
            throw new Error('Failed to save demand import: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    async generateDemand(dto: DemandGenerationDto) {
        this.logger.log(`Starting demand generation for ${dto.month} ${dto.year}`);

        const monthNum = MONTH_MAP[dto.month] || 0;
        const yearNum = parseInt(dto.year);
        if (!monthNum || !yearNum) throw new Error('Invalid date parameters');

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // BUG FIX: dto.divisionRO was accepted (and required by the frontend form)
            // but never actually applied anywhere — every call generated demand for
            // EVERY active member system-wide regardless of the selected division.
            // Confirmed live: member_master.wingno really does hold values like
            // 'BHILAI' matching the frontend's Division/RO dropdown, so that's the
            // real scoping column. The existing-demand guard below has to be scoped
            // the same way, or the first division to generate for a month would make
            // every other division's later "Generate" call silently no-op (it would
            // see demand already exists for that month/year and skip entirely).
            // dto.from/dto.to (a branch-range selector) are NOT wired up here — their
            // intended semantics (a range over which branch field, compared how) isn't
            // established in the frontend/DB and needs a product decision, not a guess.
            const countResult = await queryRunner.query(
                `SELECT COUNT(*) as cnt FROM demand_master dm
                 JOIN member_master m ON m.mbno = dm.mbno
                 WHERE dm.demand_for_month = $1 AND dm.demand_for_year = $2 AND m.wingno = $3`,
                [monthNum, yearNum, dto.divisionRO]
            );
            if (parseInt(countResult[0]?.cnt || '0') > 0) {
                await queryRunner.rollbackTransaction();
                return { success: true, message: `Demand for ${dto.month} ${dto.year} (${dto.divisionRO}) already exists. Skipped.` };
            }

            // BUG FIX: `isactive IS NOT FALSE` is a boolean-only comparison, but
            // member_master.isactive is varchar('Y'/'N') — confirmed live this crashed
            // with a Postgres type error ("argument of IS NOT FALSE must be type
            // boolean") on every single call. This function never once ran
            // successfully before this fix, independent of the scoping bug above.
            // Matches the same "active unless explicitly N" convention already used
            // in member-balance-transfer.service.ts.
            const members = await queryRunner.query(
                `SELECT mbno, officeno FROM member_master
                 WHERE (isactive = 'Y' OR isactive IS NULL) AND wingno = $1`,
                [dto.divisionRO]
            );
            const activeLoans = await queryRunner.query(
                `SELECT mbno, COALESCE(SUM(instal_amt), 0) as total_emi FROM loan_master WHERE balance > 0 GROUP BY mbno`
            );
            const loanMap = new Map(activeLoans.map((l: any) => [l.mbno, parseFloat(l.total_emi)]));

            // Arrears carry-forward: whatever a member didn't clear from the
            // immediately preceding month's demand rolls into this month's demand,
            // so a missed month keeps showing up as due instead of disappearing.
            let prevMonth = monthNum - 1;
            let prevYear = yearNum;
            if (prevMonth === 0) {
                prevMonth = 12;
                prevYear -= 1;
            }
            const arrearsRows = await queryRunner.query(
                `SELECT mbno, balance_for_month FROM demand_master
                 WHERE demand_for_month = $1 AND demand_for_year = $2 AND balance_for_month > 0`,
                [prevMonth, prevYear]
            );
            const arrearsMap = new Map(arrearsRows.map((r: any) => [r.mbno, parseFloat(r.balance_for_month) || 0]));

            // BUG FIX: dmnd_srno and officeno are both NOT NULL with no DB default,
            // but the INSERT below never set either — confirmed live, this crashed
            // with a not-null-constraint violation on officeno the moment the two
            // bugs above were fixed and this code ran for the first time ever. Mirrors
            // the already-working sibling import path's pattern (same file, "Get next
            // dmnd_srno" section) exactly: MAX(dmnd_srno)+1, officeno from the member's
            // own member_master row.
            const maxSrnoResult = await queryRunner.query(`SELECT COALESCE(MAX(dmnd_srno), 0) as max_srno FROM demand_master`);
            let nextSrno = Number(maxSrnoResult[0]?.max_srno || 0) + 1;

            let count = 0;
            for (const member of members) {
                const currentEmi = Number(loanMap.get(member.mbno)) || 0;
                const arrears = Number(arrearsMap.get(member.mbno)) || 0;
                const totalDemand = currentEmi + arrears;
                if (totalDemand > 0) {
                    await queryRunner.query(
                        `INSERT INTO demand_master (dmnd_srno, demand_for_month, demand_for_year, mbno, totaldemand, balance_for_month, officeno)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [nextSrno++, monthNum, yearNum, member.mbno, totalDemand, totalDemand, member.officeno]
                    );
                    count++;
                }
            }

            // Snapshot balances for generated demands too
            if (count > 0) {
                const mbnos = members.map((m: any) => Number(m.mbno)).filter((n: number) => !isNaN(n));
                await this.snapshotMemberBalances(queryRunner, mbnos, monthNum, yearNum);
            }

            await queryRunner.commitTransaction();
            return { success: true, message: `Generated demand for ${count} members for ${dto.month} ${dto.year}.` };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Demand generation failed', error);
            throw new Error('Failed to generate demand: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    private async snapshotMemberBalances(
        queryRunner: any,
        memberNos: number[],
        monthNum: number,
        yearNum: number,
    ): Promise<void> {
        if (memberNos.length === 0) return;

        // Batch-fetch loan balances by type
        const loanBalances = await queryRunner.query(`
            SELECT mbno, loantype,
                   COALESCE(SUM(balance), 0) as bal
            FROM loan_master
            WHERE mbno = ANY($1) AND balance > 0
            GROUP BY mbno, loantype
        `, [memberNos.map(String)]);

        // Batch-fetch fund balances
        const fundBalances = await queryRunner.query(`
            SELECT mbno,
                   COALESCE(cdopbal, 0) + COALESCE(cdamt, 0) as cd_bal,
                   COALESCE(mdopbal, 0) + COALESCE(mdamt, 0) as md_bal,
                   COALESCE(shareopbal, 0) + COALESCE(shareamt, 0) as shr_bal
            FROM fundsmaster
            WHERE mbno = ANY($1)
        `, [memberNos.map(String)]);

        // Build lookup maps
        const loanMap = new Map<string, Record<string, number>>();
        for (const row of loanBalances) {
            const key = String(row.mbno);
            if (!loanMap.has(key)) loanMap.set(key, {});
            loanMap.get(key)![row.loantype] = parseFloat(row.bal) || 0;
        }

        const fundMap = new Map<string, any>();
        for (const row of fundBalances) {
            fundMap.set(String(row.mbno), row);
        }

        // Update each demand record with balances
        for (const mbno of memberNos) {
            const key = String(mbno);
            const loans = loanMap.get(key) || {};
            const funds = fundMap.get(key);

            const rlnBal = loans['RLN'] || 0;
            const alnBal = (loans['ALN'] || 0) + (loans['ELN'] || 0);
            const cdBal = funds ? parseFloat(funds.cd_bal) || 0 : 0;
            const mdBal = funds ? parseFloat(funds.md_bal) || 0 : 0;
            const shrBal = funds ? parseFloat(funds.shr_bal) || 0 : 0;

            await queryRunner.query(`
                UPDATE demand_master
                SET rdbalance = ROUND($1::numeric, 2),
                    mdbalance = ROUND($2::numeric, 2),
                    cdbalance = ROUND($3::numeric, 2),
                    shrbalance = ROUND($4::numeric, 2)
                WHERE demand_for_month = $5 AND demand_for_year = $6 AND mbno = $7
            `, [rlnBal + alnBal, mdBal, cdBal, shrBal, monthNum, yearNum, mbno]);
        }

        this.logger.log(`Snapshot balances for ${memberNos.length} members in demand ${monthNum}/${yearNum}`);
    }
}
