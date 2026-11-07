import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseBusinessDate } from '../../shared/utils/date-utils';
import {
  MemberBalanceInquiryDto,
  AccountStatementDto,
  MemberBalance,
  AccountBalance,
  AccountStatement,
  AccountStatementTransaction
} from '../dto/balance.dto';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Balance inquiries and statements read the tables the society actually works in (ES-427):
 * member_master (members), member_balances (shares / deposits), loan_master (loans) and ledger (postings).
 * The old version read the empty ORM tables (members, loan_accounts, transactions) and answered
 * "Member not found" or zero for every real member.
 */
@Injectable()
export class BalanceService {
  constructor(private readonly dataSource: DataSource) {}

  private async findMember(memberId: number) {
    const rows = await this.dataSource.query(
      `SELECT m.mbno::text AS mbno,
              TRIM(CONCAT(m.f_name, ' ', COALESCE(m.l_name, ''))) AS name,
              COALESCE(b.shares, 0) AS shares,
              COALESCE(b.compulsory_deposit, 0) AS compulsory_deposit,
              COALESCE(b.rd_amt, 0) AS rd_amt
         FROM member_master m
         LEFT JOIN member_balances b ON b.mbno::text = m.mbno::text
        WHERE m.mbno::text = $1
        LIMIT 1`,
      [String(memberId)],
    );
    if (rows.length === 0) throw new NotFoundException(`Member ${memberId} was not found`);
    return rows[0];
  }

  async getMemberBalance(inquiryDto: MemberBalanceInquiryDto): Promise<MemberBalance> {
    const { memberId, asOfDate } = inquiryDto;
    const cutoffDate = asOfDate ? parseBusinessDate(asOfDate, 'As-of date', 0) : new Date();

    const member = await this.findMember(memberId);

    const shareBalance = round2(Number(member.shares) || 0);
    // compulsory deposit + recurring deposit are what the member holds with the society
    const totalDepositBalance = round2((Number(member.compulsory_deposit) || 0) + (Number(member.rd_amt) || 0));

    const loan = await this.dataSource.query(
      `SELECT COALESCE(SUM(CAST(balance AS numeric)), 0) AS total
         FROM loan_master
        WHERE mbno::text = $1 AND CAST(balance AS numeric) > 0`,
      [member.mbno],
    );
    const totalLoanBalance = round2(Number(loan[0]?.total) || 0);

    const last = await this.dataSource.query(
      `SELECT MAX(trans_date) AS last_date FROM ledger WHERE mbno::text = $1 AND trans_date <= $2`,
      [member.mbno, cutoffDate],
    );

    return {
      memberId: Number(member.mbno),
      memberNumber: member.mbno,
      memberName: member.name,
      shareBalance,
      totalLoanBalance,
      totalDepositBalance,
      netBalance: round2(shareBalance + totalDepositBalance - totalLoanBalance),
      lastTransactionDate: last[0]?.last_date || null,
      asOfDate: cutoffDate,
    };
  }

  /**
   * A single loan by case number. Case numbers are shared between members in the migrated data (ES-391), so a
   * case number that belongs to more than one loan is refused instead of returning somebody else's loan.
   */
  async getAccountBalance(accountType: string, accountId: number): Promise<AccountBalance> {
    if (String(accountType).toLowerCase() !== 'loan') {
      throw new BadRequestException(`Account type '${String(accountType).slice(0, 20)}' is not supported. Use 'loan'.`);
    }
    const rows = await this.dataSource.query(
      `SELECT loancaseno::text AS loancaseno, mbno::text AS mbno, CAST(balance AS numeric) AS balance, payment_date
         FROM loan_master WHERE loancaseno::text = $1`,
      [String(accountId)],
    );
    if (rows.length === 0) throw new NotFoundException(`Loan account ${accountId} was not found`);
    if (rows.length > 1) {
      throw new BadRequestException(
        `Loan case number ${accountId} is used by ${rows.length} members. Open the loan from the member's own account list instead.`,
      );
    }
    const loan = rows[0];
    const balance = round2(Number(loan.balance) || 0);
    const last = await this.dataSource.query(
      `SELECT MAX(trans_date) AS last_date FROM ledger WHERE mbno::text = $1 AND acc_no = $2 AND acc_type IN ('RLN','ALN','ELN')`,
      [loan.mbno, Number(loan.loancaseno)],
    );
    return {
      accountId: Number(loan.loancaseno),
      accountNumber: loan.loancaseno,
      accountType: 'loan',
      currentBalance: balance,
      availableBalance: balance,
      lastTransactionDate: last[0]?.last_date || loan.payment_date || null,
      status: balance > 0 ? 'ACTIVE' : 'CLOSED',
    };
  }

  async generateAccountStatement(statementDto: AccountStatementDto): Promise<AccountStatement> {
    const { memberId, accountType, accountId } = statementDto;
    const from = parseBusinessDate(statementDto.fromDate, 'From date', 0);
    const to = parseBusinessDate(statementDto.toDate, 'To date', 0);
    if (from.getTime() > to.getTime()) throw new BadRequestException('From date cannot be after To date.');

    const member = await this.findMember(memberId);

    const filters: string[] = ['mbno::text = $1'];
    const params: any[] = [member.mbno];
    let account: { id: number; accountNumber: string } | null = null;
    if (accountType && accountId) {
      if (String(accountType).toLowerCase() !== 'loan') {
        throw new BadRequestException(`Account type '${String(accountType).slice(0, 20)}' is not supported. Use 'loan'.`);
      }
      const loan = await this.dataSource.query(
        `SELECT loancaseno::text AS loancaseno FROM loan_master WHERE loancaseno::text = $1 AND mbno::text = $2 LIMIT 1`,
        [String(accountId), member.mbno],
      );
      if (loan.length === 0) throw new NotFoundException(`Loan account ${accountId} was not found for member ${member.mbno}`);
      account = { id: Number(loan[0].loancaseno), accountNumber: loan[0].loancaseno };
      params.push(account.id);
      filters.push(`acc_no = $${params.length}`, `acc_type IN ('RLN','ALN','ELN')`);
    }
    const where = filters.join(' AND ');

    const opening = await this.dataSource.query(
      `SELECT COALESCE(SUM(CASE WHEN trans_type = 'CR' THEN trans_amt ELSE -trans_amt END), 0) AS balance
         FROM ledger WHERE ${where} AND trans_date < $${params.length + 1}`,
      [...params, from],
    );
    const openingBalance = round2(Number(opening[0]?.balance) || 0);

    // the "to" day is included in full
    const toEnd = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
    const rows = await this.dataSource.query(
      `SELECT trans_no::text AS trans_no, trans_date, trans_type, trans_amt, receipt_vchr_no, narration
         FROM ledger WHERE ${where} AND trans_date >= $${params.length + 1} AND trans_date < $${params.length + 2}
        ORDER BY trans_date ASC, trans_no ASC, ledgerid ASC`,
      [...params, from, toEnd],
    );

    let running = openingBalance;
    let totalDebits = 0;
    let totalCredits = 0;
    const transactions: AccountStatementTransaction[] = rows.map((r: any) => {
      const amount = Number(r.trans_amt) || 0;
      const isCredit = r.trans_type === 'CR';
      const debitAmount = isCredit ? 0 : amount;
      const creditAmount = isCredit ? amount : 0;
      running = round2(running + creditAmount - debitAmount);
      totalDebits += debitAmount;
      totalCredits += creditAmount;
      return {
        date: r.trans_date,
        transactionNumber: r.trans_no,
        description: r.narration || '',
        debitAmount,
        creditAmount,
        balance: running,
        voucherNumber: r.receipt_vchr_no || undefined,
      };
    });

    return {
      member: { id: Number(member.mbno), memberNumber: member.mbno, name: member.name },
      account: {
        id: account?.id || 0,
        accountNumber: account?.accountNumber || 'ALL_ACCOUNTS',
        accountType: accountType || 'all',
        openingBalance,
        closingBalance: running,
      },
      period: { fromDate: from, toDate: to },
      transactions,
      summary: {
        totalDebits: round2(totalDebits),
        totalCredits: round2(totalCredits),
        transactionCount: transactions.length,
      },
    };
  }

  async getMemberAccountBalances(memberId: number): Promise<{
    shareBalance: number;
    loanAccounts: AccountBalance[];
    depositAccounts: AccountBalance[];
    totalLoanBalance: number;
    totalDepositBalance: number;
    netWorth: number;
  }> {
    const member = await this.findMember(memberId);
    const shareBalance = round2(Number(member.shares) || 0);

    const loans = await this.dataSource.query(
      `SELECT loancaseno::text AS loancaseno, loantype, CAST(balance AS numeric) AS balance, payment_date
         FROM loan_master
        WHERE mbno::text = $1 AND CAST(balance AS numeric) > 0
        ORDER BY payment_date, loancaseno`,
      [member.mbno],
    );
    const loanAccounts: AccountBalance[] = loans.map((l: any) => ({
      accountId: Number(l.loancaseno),
      accountNumber: l.loancaseno,
      accountType: 'loan',
      currentBalance: round2(Number(l.balance) || 0),
      availableBalance: round2(Number(l.balance) || 0),
      lastTransactionDate: l.payment_date || null,
      status: 'ACTIVE',
    }));
    const totalLoanBalance = round2(loanAccounts.reduce((s, a) => s + a.currentBalance, 0));

    const depositAccounts: AccountBalance[] = [];
    const cd = round2(Number(member.compulsory_deposit) || 0);
    const rd = round2(Number(member.rd_amt) || 0);
    if (cd > 0) depositAccounts.push({ accountId: 0, accountNumber: 'CD', accountType: 'compulsory-deposit', currentBalance: cd, availableBalance: cd, lastTransactionDate: null as any, status: 'ACTIVE' });
    if (rd > 0) depositAccounts.push({ accountId: 0, accountNumber: 'RD', accountType: 'recurring-deposit', currentBalance: rd, availableBalance: rd, lastTransactionDate: null as any, status: 'ACTIVE' });
    const totalDepositBalance = round2(cd + rd);

    return {
      shareBalance,
      loanAccounts,
      depositAccounts,
      totalLoanBalance,
      totalDepositBalance,
      netWorth: round2(shareBalance + totalDepositBalance - totalLoanBalance),
    };
  }

  async getRealtimeBalance(memberId: number): Promise<MemberBalance> {
    return this.getMemberBalance({ memberId });
  }
}
