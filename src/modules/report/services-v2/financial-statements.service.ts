import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class FinancialStatementsService {
    constructor(private readonly dataSource: DataSource) { }

    /**
     * Get all report schedules by type
     */
    async getAllReportSchedules(type?: string) {
        const query = `
      SELECT id, schedule_name, template_name, report_type, created_at 
      FROM report_schedule_header 
      WHERE ($1::text IS NULL OR report_type = $1)
      ORDER BY id DESC
    `;
        const result = await this.dataSource.query(query, [type]);
        return { success: true, data: result };
    }

    /**
     * Get schedule details by ID
     */
    async getReportScheduleDetails(id: number) {
        const headerQuery = `SELECT * FROM report_schedule_header WHERE id = $1`;
        const detailsQuery = `SELECT * FROM report_schedule_details WHERE schedule_id = $1 ORDER BY id ASC`;

        const header = await this.dataSource.query(headerQuery, [id]);
        if (header.length === 0) {
            return { success: false, error: 'Schedule not found' };
        }

        const details = await this.dataSource.query(detailsQuery, [id]);
        return {
            success: true,
            data: {
                ...header[0],
                details
            }
        };
    }

    /**
     * Create a new report schedule
     */
    async createReportSchedule(dto: {
        schedule_name: string;
        template_name: string;
        report_type: string;
        details: { particulars: string; code_from: string; code_to: string }[];
        id?: number;
    }) {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            let scheduleId = dto.id;

            if (scheduleId) {
                // Update existing header
                await queryRunner.query(
                    `UPDATE report_schedule_header SET schedule_name = $1, template_name = $2, report_type = $3, updated_at = NOW() WHERE id = $4`,
                    [dto.schedule_name, dto.template_name, dto.report_type, scheduleId]
                );
                // Delete existing details
                await queryRunner.query(`DELETE FROM report_schedule_details WHERE schedule_id = $1`, [scheduleId]);
            } else {
                // Insert new header
                const result = await queryRunner.query(
                    `INSERT INTO report_schedule_header (schedule_name, template_name, report_type, created_at, updated_at) 
           VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id`,
                    [dto.schedule_name, dto.template_name, dto.report_type]
                );
                scheduleId = result[0].id;
            }

            // Insert details
            if (dto.details && dto.details.length > 0) {
                // Construct bulk insert safely? TypeORM doesn't support bulk insert with raw query easily for variable length.
                // We'll loop for now, it's metadata, not high volume.
                for (const detail of dto.details) {
                    await queryRunner.query(
                        `INSERT INTO report_schedule_details (schedule_id, particulars, code_from, code_to) VALUES ($1, $2, $3, $4)`,
                        [scheduleId, detail.particulars, detail.code_from, detail.code_to]
                    );
                }
            }

            await queryRunner.commitTransaction();
            return { success: true, data: { id: scheduleId } };
        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error('Error creating schedule:', error);
            return { success: false, error: 'Failed to create schedule' };
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Execute a report schedule (Trial Balance, PL, BS)
     * Calculates totals from tblcashbook based on defined ranges
     */
    async executeReportSchedule(dto: {
        scheduleId: number;
        fromDate: string;
        toDate: string;
        financialYearStart: string;
    }) {
        const { scheduleId, fromDate, toDate, financialYearStart } = dto;

        // 1. Get Schedule Details
        const scheduleDetails = await this.dataSource.query(
            `SELECT * FROM report_schedule_details WHERE schedule_id = $1 ORDER BY id ASC`,
            [scheduleId]
        );

        if (!scheduleDetails || scheduleDetails.length === 0) {
            return { success: false, error: 'Schedule details not found' };
        }

        // 2. Get Society Info (Mock or Fetch)
        const societyInfo = {
            name: 'ESPAT EMPLOYEES CO-OP CREDIT SOCIETY',
            address: 'Report Generated Systematically'
        };

        // 3. Calculate Totals for each line item
        const lineItems = [];
        let grandTotals = {
            currentReceipts: 0,
            currentPayments: 0,
            currentBalance: 0,
            progressiveReceipts: 0,
            progressivePayments: 0,
            progressiveBalance: 0
        };

        for (const item of scheduleDetails) {
            // Logic: Sum(cash receipts + transfer receipts) and Sum(cash payments + transfer payments)
            // Grouped by the code range provided.

            const query = `
        SELECT
          SUM(CASE WHEN trans_date >= $1 AND trans_date <= $2 THEN COALESCE(pcash, 0) + COALESCE(ptransfer, 0) ELSE 0 END) as cur_payments,
          SUM(CASE WHEN trans_date >= $1 AND trans_date <= $2 THEN COALESCE(rcash, 0) + COALESCE(rtransfer, 0) ELSE 0 END) as cur_receipts,
          SUM(CASE WHEN trans_date >= $3 AND trans_date <= $2 THEN COALESCE(pcash, 0) + COALESCE(ptransfer, 0) ELSE 0 END) as prog_payments,
          SUM(CASE WHEN trans_date >= $3 AND trans_date <= $2 THEN COALESCE(rcash, 0) + COALESCE(rtransfer, 0) ELSE 0 END) as prog_receipts
        FROM tblcashbook
        WHERE headcode >= $4 AND headcode <= $5
      `;

            const result = await this.dataSource.query(query, [
                fromDate,
                toDate,
                financialYearStart,
                item.code_from,
                item.code_to
            ]);

            const row = result[0];

            const currentReceipts = parseFloat(row.cur_receipts || 0);
            const currentPayments = parseFloat(row.cur_payments || 0);
            const progReceipts = parseFloat(row.prog_receipts || 0);
            const progPayments = parseFloat(row.prog_payments || 0);

            // Balance calculation depends on report type usually, but generic balance is (Receipts - Payments) or (Payments - Receipts) depending on asset/liability
            // For Trial Balance, usually Dr (Payments) vs Cr (Receipts).
            // Let's assume standard: Receipts - Payments (Positive = Credit Balance / Income, Negative = Debit Balance / Expense)
            // Actually in Trial Balance: 
            // Debit Balance = Expenses + Assets
            // Credit Balance = Income + Liabilities
            // We return raw R/P and let frontend display. 
            // The "Balance" here will be Net Flow. 
            // Ideally we should know if it's Dr or Cr, but for simplicity: Receipts - Payments

            const currentBalance = currentReceipts - currentPayments;
            const progressiveBalance = progReceipts - progPayments;

            lineItems.push({
                particulars: item.particulars,
                codeFrom: item.code_from,
                codeTo: item.code_to,
                current: {
                    receipts: currentReceipts,
                    payments: currentPayments,
                    balance: currentBalance
                },
                progressive: {
                    receipts: progReceipts,
                    payments: progPayments,
                    balance: progressiveBalance
                }
            });

            // Update Grand Totals
            grandTotals.currentReceipts += currentReceipts;
            grandTotals.currentPayments += currentPayments;
            grandTotals.currentBalance += currentBalance;
            grandTotals.progressiveReceipts += progReceipts;
            grandTotals.progressivePayments += progPayments;
            grandTotals.progressiveBalance += progressiveBalance;
        }

        return {
            success: true,
            data: {
                societyName: societyInfo.name,
                societyAddress: societyInfo.address,
                lineItems,
                grandTotals
            }
        };
    }

    /**
     * Get Balance Sheet data
     */
    async getBalanceSheet(asOnDate?: string) {
        const query = `
            SELECT 
                head_code,
                head_name,
                opening_balance,
                debit,
                credit,
                closingbalance,
                maincd
            FROM balancesheet 
            ORDER BY maincd, head_code
        `;
        
        const result = await this.dataSource.query(query);
        
        // Group by main categories
        const liabilities = result.filter((item: any) => item.maincd === 1);
        const assets = result.filter((item: any) => item.maincd === 2);
        
        // Calculate totals
        const totalLiabilities = liabilities.reduce((sum: number, item: any) => 
            sum + (parseFloat(item.closingbalance) || 0), 0);
        const totalAssets = assets.reduce((sum: number, item: any) => 
            sum + (parseFloat(item.closingbalance) || 0), 0);
            
        return {
            success: true,
            data: {
                liabilities: liabilities.map((item: any) => ({
                    headCode: item.head_code,
                    headName: item.head_name,
                    openingBalance: parseFloat(item.opening_balance) || 0,
                    debit: parseFloat(item.debit) || 0,
                    credit: parseFloat(item.credit) || 0,
                    closingBalance: parseFloat(item.closingbalance) || 0
                })),
                assets: assets.map((item: any) => ({
                    headCode: item.head_code,
                    headName: item.head_name,
                    openingBalance: parseFloat(item.opening_balance) || 0,
                    debit: parseFloat(item.debit) || 0,
                    credit: parseFloat(item.credit) || 0,
                    closingBalance: parseFloat(item.closingbalance) || 0
                })),
                totals: {
                    totalLiabilities,
                    totalAssets,
                    difference: totalAssets - totalLiabilities
                }
            }
        };
    }
}
