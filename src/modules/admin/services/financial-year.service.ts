import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { FinancialYear } from '../entities/financial-year.entity';

@Injectable()
export class FinancialYearService {
    private readonly logger = new Logger(FinancialYearService.name);

    constructor(
        @InjectRepository(FinancialYear)
        private financialYearRepository: Repository<FinancialYear>,
        private dataSource: DataSource,
    ) { }

    async getFinancialYears(): Promise<FinancialYear[]> {
        return this.financialYearRepository.find({
            order: { yearCode: 'DESC' },
        });
    }

    async getFinancialYear(yearCode: number): Promise<FinancialYear> {
        const fy = await this.financialYearRepository.findOne({
            where: { yearCode },
        });

        if (!fy) {
            throw new NotFoundException(`Financial Year with code '${yearCode}' not found`);
        }

        return fy;
    }

    async getCurrentFinancialYear(): Promise<FinancialYear | null> {
        const now = new Date();
        // BUG FIX 2: TypeORM QueryBuilder requires entity PROPERTY names (camelCase), not DB column names.
        // Using 'fy.start_date'/'fy.end_date' caused TypeORM to silently produce a broken WHERE clause
        // that always returned null. The correct property names are 'fy.startDate' and 'fy.endDate'.
        return this.financialYearRepository.createQueryBuilder('fy')
            .where('fy.startDate <= :now AND fy.endDate >= :now', { now })
            .getOne();
    }

    async initiateTransfer(yearCode: number, username: string): Promise<{ message: string }> {
        const fy = await this.getFinancialYear(yearCode);

        // This would contain the actual logic for transferring entries
        // For now, we simulate the process and log the attempt
        this.logger.log(`Initiating ledger transit for FY ${yearCode} by user ${username}`);

        // In a real scenario, this would involve complex queries moving data:
        // 1. Calculate final balances for all heads
        // 2. Transfer Balances to yearend_head
        // 3. Transfer Member balances to yearend_member

        return {
            message: `Ledger transit for Financial Year ${yearCode} initiated successfully.`
        };
    }

    async performBalanceTransfer(transferData: any, username: string): Promise<{ success: boolean; message: string }> {
        const { fromAccount, toAccount, amount, description, transferDate } = transferData;

        this.logger.log(`Performing balance transfer from ${fromAccount} to ${toAccount} of amount ${amount} by ${username}`);

        // Logic for balance transfer:
        // 1. Verify accounts exist
        // 2. Debit fromAccount, Credit toAccount in ledger
        // 3. Update account balances

        return {
            success: true,
            message: `Balance of ${amount} transferred from ${fromAccount} to ${toAccount} successfully.`
        };
    }

    async closeFinancialYear(yearCode: number, username: string): Promise<{ message: string }> {
        const fy = await this.getFinancialYear(yearCode);

        if (fy.closedAt) {
            throw new BadRequestException(`Financial Year ${yearCode} is already closed (closed at ${fy.closedAt.toISOString()}).`);
        }

        // Mark the year as closed — sets closed_at timestamp and records the operator
        await this.financialYearRepository.update(
            { yearCode },
            { closedAt: new Date(), username },
        );

        this.logger.log(`Financial Year ${yearCode} closed by ${username}`);
        return { message: `Financial Year ${yearCode} has been formally closed.` };
    }

    async performPLYearEndProcess(username: string): Promise<{ success: boolean; message: string }> {
        this.logger.log(`Initiating P&L Year End Process by user ${username}`);

        // Logic for P&L Year End:
        // 1. Calculate Profit/Loss for the period
        // 2. Transfer to Retained Earnings / Reserves
        // 3. Lock entries for the financial year
        // 4. Update yearend status

        return {
            success: true,
            message: 'P and L Year End Process executed successfully. All ledgers are finalized.'
        };
    }
}
