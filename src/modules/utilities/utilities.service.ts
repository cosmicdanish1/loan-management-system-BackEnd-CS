import { Injectable, Logger, BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { assertPostingDateOpen, getWorkingDateText, resolvePostingDate, postingDateAsDate } from '../shared/utils/posting-date';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { UserPreference } from './entities/user-preference.entity';
import { SystemSetting } from './entities/system-setting.entity';
import { UpdateUserPreferenceDto } from './dto/update-user-preference.dto';
import { RD_RULE_DEFAULTS, RD_RULE_KEYS, RD_BOOLEAN_RULE_KEYS } from '../rd/rd-business-rules';
import { HEAD_BALANCES_SELECT } from './head-balances.sql';
import { generateVoucherNo } from '../shared/utils/voucher-utils';
import { parseBusinessDate } from '../shared/utils/date-utils';
import { lockLedgerIds, lockNextId } from '../shared/utils/ledger-lock';
import { DIVIDEND_RATE_KEYS, dividendRateRulesFrom, validateDividendRateRuleSettings } from '../dividend/dividend-rate-rules';

/**
 * A stored day-of-month setting, forced into 1-31. Deliberately NOT validated
 * against any specific month's real length: a window ending on the 31st has to
 * keep meaning "the end of the month" in February too.
 */
function clampDayOfMonth(value: any, fallback: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 31) return fallback;
  return n;
}

/** Account type stamped on a staged receipt / payment line, by head code (the tags the legacy and migrated ledger use). */
const ACC_TYPE_BY_HEAD: Record<string, string> = { A1002: 'RLN', A1047: 'ALN', L1004: 'CD', L1001: 'SHR', L1002: 'MD', L1045: 'MD1' };

@Injectable()
export class UtilitiesService {
  /** Month name (JAN..DEC) or number (1..12) -> 1..12, or 0 when it is not a month. */
  static monthNumber(m: any): number {
    const names = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const s = String(m ?? '').trim().toUpperCase();
    const i = names.indexOf(s.slice(0, 3));
    if (i >= 0) return i + 1;
    const n = Number(s);
    return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 0;
  }

  private readonly logger = new Logger(UtilitiesService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(UserPreference)
    private readonly preferenceRepo: Repository<UserPreference>,
    @InjectRepository(SystemSetting)
    private readonly systemRepo: Repository<SystemSetting>
  ) { }

  async searchDeposits(memberNo: string, type: 'RD' | 'FD'): Promise<any[]> {
    try {
      this.logger.log(`Searching ${type} deposits for member: ${memberNo}`);

      if (type === 'RD') {
        // RD accounts are stored in fdmaster with fdrdflag = 'R'
        const query = `
          SELECT 
            account_number as "accountNumber",
            mbno as "memberId",
            fdamount as "monthlyInstallment",
            rate as "interestRate",
            depdate as "startDate",
            matdate as "maturityDate",
            depperiod as "tenureMonths",
            matamount as "maturityAmount",
            COALESCE(openbal, 0) as "totalDeposited",
            CASE 
              WHEN depdate IS NOT NULL THEN 
                EXTRACT(YEAR FROM AGE(CURRENT_DATE, depdate)) * 12 + 
                EXTRACT(MONTH FROM AGE(CURRENT_DATE, depdate))
              ELSE 0 
            END as "installmentsPaid",
            CASE WHEN status = '0' THEN 'ACTIVE' ELSE status END as "status"
          FROM fdmaster 
          WHERE mbno = $1 
          AND fdrdflag = 'R'
          AND (status = '0' OR status IS NULL)
          ORDER BY depdate DESC
        `;

        const result = await this.dataSource.query(query, [parseInt(memberNo)]);
        this.logger.log(`Found ${result.length} RD accounts for member ${memberNo}`);
        return result;

      } else if (type === 'FD') {
        // FD accounts are also in fdmaster with fdrdflag = 'F'
        const query = `
          SELECT 
            account_number as "accountNumber",
            mbno as "memberId",
            fdamount as "depositAmount",
            rate as "interestRate",
            depdate as "startDate",
            matdate as "maturityDate",
            depperiod as "tenureMonths",
            matamount as "maturityAmount",
            CASE WHEN status = '0' THEN 'ACTIVE' ELSE status END as "status"
          FROM fdmaster 
          WHERE mbno = $1 
          AND fdrdflag = 'F'
          AND (status = '0' OR status IS NULL)
          ORDER BY depdate DESC
        `;

        const result = await this.dataSource.query(query, [parseInt(memberNo)]);
        this.logger.log(`Found ${result.length} FD accounts for member ${memberNo}`);
        return result;
      }

      return [];
    } catch (error) {
      this.logger.error(`Error searching ${type} deposits for member ${memberNo}:`, error);
      return [];
    }
  }

  async searchSBAccounts(memberNo: string): Promise<any[]> {
    try {
      this.logger.log(`Searching SB accounts for member: ${memberNo}`);

      // We synthesize an SB account from the ledger table since there's no dedicated savings_accounts table
      const query = `
        SELECT 
          'SB-' || mbno as "accountNumber",
          mbno as "memberId",
          (SELECT COALESCE(rate::numeric, 4.0) FROM interestmaster WHERE inttype = 'SB' ORDER BY todt DESC LIMIT 1) as "interestRate",
          SUM(CASE WHEN trans_type = 'CR' THEN trans_amt::numeric ELSE -trans_amt::numeric END) as "currentBalance",
          MIN(trans_date) as "openingDate",
          (SELECT COALESCE(minsavingbalance, 1000) FROM busrules ORDER BY appdate DESC LIMIT 1) as "minimumBalance",
          'ACTIVE' as "status",
          MAX(trans_date) as "lastTransactionDate"
        FROM ledger 
        WHERE mbno = $1 AND acc_type = 'SB'
        GROUP BY mbno
      `;

      const result = await this.dataSource.query(query, [parseInt(memberNo)]);
      this.logger.log(`Found ${result.length} SB accounts for member ${memberNo}`);
      return result;

    } catch (error) {
      this.logger.error(`Error searching SB accounts for member ${memberNo}:`, error);
      return [];
    }
  }

  async getMemberBalance(memberNo: string): Promise<any> {
    try {
      this.logger.log(`Getting balance for member: ${memberNo}`);

      // Get member basic info
      const memberQuery = `
        SELECT 
          mbno,
          CONCAT(f_name, ' ', COALESCE(m_name, ''), ' ', l_name) as name,
          basic_pay,
          dept_name
        FROM member_master 
        WHERE mbno = $1
      `;

      const memberResult = await this.dataSource.query(memberQuery, [parseInt(memberNo)]);

      if (memberResult.length === 0) {
        return null;
      }

      const member = memberResult[0];

      // Get RD summary
      const rdQuery = `
        SELECT 
          COUNT(*) as rd_accounts,
          COALESCE(SUM("totalDeposited"), 0) as total_rd_deposited,
          COALESCE(SUM("monthlyInstallment"), 0) as total_monthly_installment
        FROM recurring_deposits 
        WHERE "memberId" = $1 
        AND ("status" = 'ACTIVE' OR "status" IS NULL)
      `;

      const rdResult = await this.dataSource.query(rdQuery, [parseInt(memberNo)]);

      // Get FD summary
      const fdQuery = `
        SELECT 
          COUNT(*) as fd_accounts,
          COALESCE(SUM("principalAmount"), 0) as total_fd_deposited
        FROM fixed_deposits 
        WHERE "memberId" = $1 
        AND ("status" = 'ACTIVE' OR "status" IS NULL)
      `;

      const fdResult = await this.dataSource.query(fdQuery, [parseInt(memberNo)]);

      // Get SB summary
      const sbQuery = `
        SELECT 
          CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END as sb_accounts,
          COALESCE(SUM(CASE WHEN trans_type = 'CR' THEN trans_amt::numeric ELSE -trans_amt::numeric END), 0) as total_sb_balance
        FROM ledger 
        WHERE mbno = $1 AND acc_type = 'SB'
      `;

      const sbResult = await this.dataSource.query(sbQuery, [parseInt(memberNo)]);

      // ES-607: loan balances for the Receipt window (regular and emergency, from the member's stored balances)
      const loanResult = await this.dataSource.query(
        `SELECT COALESCE(regularloan, 0) AS rln_balance, COALESCE(emergency_loan_balance, 0) AS eln_balance
           FROM member_balances WHERE mbno::numeric = $1::numeric LIMIT 1`, [parseInt(memberNo)]);

      return {
        member: member,
        loan_summary: loanResult[0] || { rln_balance: 0, eln_balance: 0 },
        rd_summary: rdResult[0] || { rd_accounts: 0, total_rd_deposited: 0, total_monthly_installment: 0 },
        fd_summary: fdResult[0] || { fd_accounts: 0, total_fd_deposited: 0 },
        sb_summary: sbResult[0] || { sb_accounts: 0, total_sb_balance: 0 }
      };

    } catch (error) {
      this.logger.error(`Error getting balance for member ${memberNo}:`, error);
      return null;
    }
  }

  async getLoanRates(): Promise<any[]> {
    try {
      this.logger.log('Getting current loan rates from business rules');

      const query = `
        SELECT 
          'Regular Loan' as name,
          'RLN' as code,
          rlnrate as rate,
          rlnmaxloanamt as max_amount,
          rlnmaxnoinst as max_tenure,
          'Standard personal loan with competitive rates' as description
        FROM busrules 
        WHERE appdate = (SELECT MAX(appdate) FROM busrules)
        UNION ALL
        SELECT
          'Loan Against RD' as name,
          'ELN' as code,
          elnrate as rate,
          elnmaxloanamt as max_amount,
          elnmaxnoinst as max_tenure,
          'Salary advance with lower interest rates' as description
        FROM busrules
        WHERE appdate = (SELECT MAX(appdate) FROM busrules)
        UNION ALL
        SELECT
          'Emergency Loan' as name,
          'ALN' as code,
          alnrate as rate,
          alnmaxloanamt as max_amount,
          alnmaxnoinst as max_tenure,
          'Quick approval for urgent financial needs' as description
        FROM busrules 
        WHERE appdate = (SELECT MAX(appdate) FROM busrules)
        UNION ALL
        SELECT 
          'Education Loan' as name,
          'EDL' as code,
          edlrate as rate,
          edlmaxloanamt as max_amount,
          84 as max_tenure,
          'Special rates for educational expenses' as description
        FROM busrules 
        WHERE appdate = (SELECT MAX(appdate) FROM busrules)
        UNION ALL
        SELECT 
          'Festival Loan' as name,
          'FLN' as code,
          flnrate as rate,
          flnmaxloanamt as max_amount,
          flnmaxnoinst as max_tenure,
          'Special loan for festival celebrations' as description
        FROM busrules 
        WHERE appdate = (SELECT MAX(appdate) FROM busrules)
        UNION ALL
        SELECT 
          'Special Loan' as name,
          'SLN' as code,
          slnrate as rate,
          slnmaxloanamt as max_amount,
          slnmaxnoinst as max_tenure,
          'Special purpose loan with flexible terms' as description
        FROM busrules 
        WHERE appdate = (SELECT MAX(appdate) FROM busrules)
      `;

      const result = await this.dataSource.query(query);

      // Convert numeric values and filter out null rates
      const loanTypes = result
        .filter(loan => loan.rate && parseFloat(loan.rate) > 0)
        .map(loan => ({
          name: loan.name,
          code: loan.code,
          rate: parseFloat(loan.rate),
          maxAmount: parseFloat(loan.max_amount || 0),
          maxTenure: parseInt(loan.max_tenure || 60),
          description: loan.description
        }));

      this.logger.log(`Found ${loanTypes.length} loan types with rates`);
      return loanTypes;

    } catch (error) {
      this.logger.error('Error getting loan rates:', error);
      return [];
    }
  }

  async getMemberEligibility(memberNo: string): Promise<any> {
    try {
      this.logger.log(`Getting loan eligibility for member: ${memberNo}`);

      // Get member basic info
      const memberQuery = `
        SELECT 
          mm.mbno,
          CONCAT(mm.f_name, ' ', COALESCE(mm.m_name, ''), ' ', mm.l_name) as name,
          mm.basic_pay,
          mm.dept_name
        FROM member_master mm
        WHERE mm.mbno = $1
      `;

      const memberResult = await this.dataSource.query(memberQuery, [parseInt(memberNo)]);

      if (memberResult.length === 0) {
        return null;
      }

      const member = memberResult[0];

      // Get active loans
      const loanQuery = `
        SELECT 
          COUNT(*) as active_loans,
          COALESCE(SUM(balance::numeric), 0) as total_outstanding,
          COALESCE(SUM(instal_amt::numeric), 0) as total_emi
        FROM loan_master 
        WHERE mbno = $1 
        AND balance::numeric > 0
      `;

      const loanResult = await this.dataSource.query(loanQuery, [parseInt(memberNo)]);
      const loanSummary = loanResult[0] || { active_loans: 0, total_outstanding: 0, total_emi: 0 };

      // Get business rules for eligibility calculation
      const businessRulesQuery = `
        SELECT 
          COALESCE(loanmaxlimit, 500000) as loanmaxlimit,
          COALESCE(loanagainstbasic, 10) as loanagainstbasic,
          COALESCE(loanagainstdeppercent, 80) as loanagainstdeppercent
        FROM busrules 
        WHERE appdate = (SELECT MAX(appdate) FROM busrules)
        LIMIT 1
      `;

      const businessRules = await this.dataSource.query(businessRulesQuery);
      const rules = businessRules[0] || {
        loanmaxlimit: 500000,
        loanagainstbasic: 10,
        loanagainstdeppercent: 80
      };

      // Calculate eligibility
      const basicPay = parseFloat(member.basic_pay || 0);
      const maxLoanLimit = parseFloat(rules.loanmaxlimit || 500000);
      const loanAgainstBasic = parseFloat(rules.loanagainstbasic || 10);

      // If basic pay is 0, use a default eligibility of 50,000
      const eligibleBasedOnSalary = basicPay > 0 ? basicPay * loanAgainstBasic : 50000;
      const maxEligible = Math.min(eligibleBasedOnSalary, maxLoanLimit);
      const currentOutstanding = parseFloat(loanSummary.total_outstanding);
      const availableEligibility = Math.max(0, maxEligible - currentOutstanding);

      return {
        memberNo: member.mbno,
        name: member.name,
        basicPay: basicPay,
        department: member.dept_name,
        activeLoans: parseInt(loanSummary.active_loans),
        totalOutstanding: currentOutstanding,
        totalEMI: parseFloat(loanSummary.total_emi),
        maxEligibleAmount: maxEligible,
        availableEligibility: availableEligibility,
        eligibilityPercentage: maxEligible > 0 ? ((availableEligibility / maxEligible) * 100).toFixed(1) : 0
      };

    } catch (error) {
      this.logger.error(`Error getting member eligibility for ${memberNo}:`, error);
      return null;
    }
  }

  async getUserPreferences(userId: number): Promise<UserPreference> {
    let prefs = await this.preferenceRepo.findOne({ where: { userId } });
    if (!prefs) {
      prefs = this.preferenceRepo.create({ userId });
      await this.preferenceRepo.save(prefs);
    }
    return prefs;
  }

  async updateUserPreferences(userId: number, updateDto: UpdateUserPreferenceDto): Promise<UserPreference> {
    let prefs = await this.preferenceRepo.findOne({ where: { userId } });
    if (!prefs) {
      prefs = this.preferenceRepo.create({ userId, ...updateDto });
    } else {
      Object.assign(prefs, updateDto);
    }
    return await this.preferenceRepo.save(prefs);
  }

  async getSystemSetting(key: string): Promise<string> {
    const setting = await this.systemRepo.findOne({ where: { key } });
    return setting ? setting.value : '';
  }

  async updateSystemSetting(key: string, value: string): Promise<SystemSetting> {
    let setting = await this.systemRepo.findOne({ where: { key } });
    if (!setting) {
      setting = this.systemRepo.create({ key, value });
    } else {
      setting.value = value;
    }
    return await this.systemRepo.save(setting);
  }

  async processBalanceTransfer(
    data: {
      fromAccount: string;
      toAccount: string;
      amount: number;
      transferDate: string;
      description: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // ES-357: refuse a bad request with a reason before anything is written
      const body: any = data ?? {};
      const from = String(body.fromAccount ?? '').trim();
      const to = String(body.toAccount ?? '').trim();
      if (!/^[0-9]{1,12}$/.test(from)) throw new BadRequestException('From account must be a member number (digits only).');
      if (!/^[0-9]{1,12}$/.test(to)) throw new BadRequestException('To account must be a member number (digits only).');
      if (from === to) throw new BadRequestException('From and To account cannot be the same.');
      const amount = typeof body.amount === 'string' ? (body.amount.trim() === '' ? NaN : Number(body.amount)) : body.amount;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw new BadRequestException('Amount must be a number greater than 0.');
      }
      if (amount > 999_999_999.99) throw new BadRequestException('Amount cannot be more than 99,99,99,999.99.');
      if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) throw new BadRequestException('Amount can have at most 2 decimal places.');
      data = { ...body, fromAccount: from, toAccount: to, amount };
      const transDate = parseBusinessDate(body.transferDate, 'Transfer date');
      await assertPostingDateOpen(queryRunner, transDate); // ES-458
      const known = await queryRunner.query(`SELECT mbno::text AS mbno FROM member_master WHERE mbno::text = ANY($1)`, [[from, to]]);
      const knownSet = new Set(known.map((r: any) => r.mbno));
      if (!knownSet.has(from)) throw new BadRequestException(`From account ${from} is not a member.`);
      if (!knownSet.has(to)) throw new BadRequestException(`To account ${to} is not a member.`);

      // two transfers (or a transfer and another posting) must not take the same numbers
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger.trans_no_ledgerid'))`);
      await lockLedgerIds(queryRunner); // ES-445: the one shared ledger id lock

      // Get next trans_no and ledgerid (both plain NUMERIC/INTEGER, no sequence)
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = maxResult[0]?.next_trans_no ?? 1;
      const nextLedgerId = maxResult[0]?.next_ledger_id ?? 1;

      // Debit from source account (fromAccount = member number)
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', 'OTH', $3, 0, 'OTH', $4, '', 'J', '', 0, $5, $6, $7)`,
        [nextTransNo, transDate, data.fromAccount, data.amount, data.description, username, nextLedgerId],
      );

      // Credit to destination account (toAccount = member number)
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', 'OTH', $3, 0, 'OTH', $4, '', 'J', '', 0, $5, $6, $7)`,
        [Number(nextTransNo) + 1, transDate, data.toAccount, data.amount, data.description, username, Number(nextLedgerId) + 1],
      );

      await queryRunner.commitTransaction();

      return {
        success: true,
        message: `Balance transfer of ${data.amount} from ${data.fromAccount} to ${data.toAccount} completed successfully.`,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof HttpException) throw error; // a 400/404 keeps its own message
      this.logger.error(`Balance transfer failed: ${error instanceof Error ? error.message : error}`);
      throw new Error('Balance transfer could not be saved. Please try again; if it keeps failing contact support.');
    } finally {
      await queryRunner.release();
    }
  }

  async saveSavingTransaction(
    data: {
      accountNo: string;
      voucherNo?: string;
      transDate: string;
      transactionType: 'deposit' | 'withdrawal';
      amount: number;
      paymentMode: 'cash' | 'bank';
      chequeNo?: string;
      chequeDate?: string;
      bankName?: string;
      narration: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // ES-302: refuse a bad request with a reason before anything is read or written
      const body: any = data ?? {};
      const accountNo = String(body.accountNo ?? '').trim();
      if (!accountNo) throw new BadRequestException('Account number is required.');
      if (body.transactionType !== 'deposit' && body.transactionType !== 'withdrawal') {
        throw new BadRequestException("Transaction type must be 'deposit' or 'withdrawal'.");
      }
      if (body.paymentMode !== 'cash' && body.paymentMode !== 'bank') {
        throw new BadRequestException("Payment mode must be 'cash' or 'bank'.");
      }
      const amountIn = typeof body.amount === 'string' ? (body.amount.trim() === '' ? NaN : Number(body.amount)) : body.amount;
      if (typeof amountIn !== 'number' || !Number.isFinite(amountIn) || amountIn <= 0) {
        throw new BadRequestException('Amount must be a number greater than 0.');
      }
      if (amountIn > 999_999_999.99) throw new BadRequestException('Amount cannot be more than 99,99,99,999.99.');
      if (Math.abs(Math.round(amountIn * 100) - amountIn * 100) > 1e-6) throw new BadRequestException('Amount can have at most 2 decimal places.');
      const parsedDate = parseBusinessDate(body.transDate, 'Transaction date');
      await assertPostingDateOpen(queryRunner, parsedDate); // ES-458
      data = { ...body, accountNo, amount: amountIn };
      this.logger.log(`[SavingTxn] Saving ${data.transactionType} for account=${data.accountNo} amount=${data.amount}`);

      // Get account details
      const accountResult = await queryRunner.query(
        // ES-453: FOR UPDATE, so two withdrawals on one account run one after the other: the second one re-reads the
        // balance after the first has committed, and the overdraft check below sees the real figure.
        `SELECT acc_no, mbno, balance FROM sbmaster WHERE acc_no = $1 FOR UPDATE`,
        [data.accountNo]
      );

      if (!accountResult || accountResult.length === 0) {
        throw new NotFoundException(`Saving account ${data.accountNo} was not found.`);
      }

      const account = accountResult[0];
      // the balance column is NUMERIC, which the driver returns as text: "1000.00" + 5 would join the text (ES-302)
      const currentBalance = Number(account.balance) || 0;
      if (data.transactionType === 'withdrawal' && data.amount > currentBalance) {
        throw new BadRequestException(`Withdrawal of ${data.amount} is more than the balance of ${currentBalance.toFixed(2)}.`);
      }
      // two postings must not take the same numbers
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger.trans_no_ledgerid'))`);
      await lockLedgerIds(queryRunner); // ES-445: the one shared ledger id lock
      const memberNo = account.mbno;

      // Get next trans_no and ledgerid
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // Generate voucher number — R for deposit, P for withdrawal
      const isDeposit = data.transactionType === 'deposit';
      const transType = isDeposit ? 'CR' : 'DR';
      const vchrType = isDeposit ? 'R' : 'P';
      let voucherNo = data.voucherNo;
      
      if (!voucherNo) {
        // ES-56: shared generator (locks the counter row and skips numbers that already exist)
        voucherNo = await generateVoucherNo(queryRunner, isDeposit ? 'R' : 'P');
      }

      const transDate = parsedDate;
      const modeOfPay = data.paymentMode === 'cash' ? 'C' : 'B';
      // the ledger has no cheque columns, so the cheque details travel in the narration
      const chequeBits = [data.chequeNo ? `Cheque ${String(data.chequeNo).slice(0, 20)}` : '', data.chequeDate ? `dt ${String(data.chequeDate).slice(0, 10)}` : ''].filter(Boolean).join(' ');
      const narrationText = [data.narration || '', chequeBits].filter(Boolean).join(' - ').slice(0, 100);

      // Member SB account leg — CR on deposit (balance increases), DR on withdrawal
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid, cust_bank_name)
         VALUES ($1, $2, $3, 'A1001', $4, $5, 'SB', $6, $7, $8, $9, 0, $10, $11, $12, $13)`,
        [
          nextTransNo,
          transDate,
          transType,
          memberNo,
          data.accountNo,
          data.amount,
          voucherNo,
          vchrType,
          modeOfPay,
          narrationText,
          username,
          nextLedgerId,
          data.bankName ? String(data.bankName).slice(0, 100) : null
        ]
      );

      // Cash/bank offsetting leg — DR on deposit (cash in), CR on withdrawal (cash out)
      const cashAccType = modeOfPay === 'B' ? 'BANK' : 'CINH';
      const cashCode = modeOfPay === 'B' ? 'A1008' : 'A1001';
      const cashTransType = isDeposit ? 'DR' : 'CR';
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid, cust_bank_name)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, 0, $11, $12, $13, $14)`,
        [
          nextTransNo + 1,
          transDate,
          cashTransType,
          cashCode,
          memberNo,
          cashAccType,
          data.amount,
          voucherNo,
          vchrType,
          modeOfPay,
          narrationText,
          username,
          nextLedgerId + 1,
          data.bankName ? String(data.bankName).slice(0, 100) : null
        ]
      );

      // Update sbmaster balance
      const newBalance = Math.round((isDeposit ? currentBalance + data.amount : currentBalance - data.amount) * 100) / 100;

      await queryRunner.query(
        `UPDATE sbmaster SET balance = $1 WHERE acc_no = $2`,
        [newBalance, data.accountNo]
      );

      await queryRunner.commitTransaction();
      this.logger.log(`[SavingTxn] Saved trans_no=${nextTransNo} vchr=${voucherNo} type=${transType} amount=${data.amount} new_balance=${newBalance}`);

      return { 
        success: true, 
        transNo: nextTransNo, 
        voucherNo, 
        message: `${isDeposit ? 'Deposit' : 'Withdrawal'} ${voucherNo} saved. Amount: ₹${data.amount}. New Balance: ₹${newBalance.toFixed(2)}` 
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof HttpException) throw error; // a 400/404 keeps its own message
      this.logger.error(`[SavingTxn] Failed:`, error);
      throw new Error(`Failed to save transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async getFdAccountsByMember(memberNo: string): Promise<any[]> {
    this.logger.log(`[FDInterest] Getting FD accounts for member ${memberNo}`);
    const result = await this.dataSource.query(
      `SELECT account_number as "accountNumber", mbno as "memberNo", certno as "certNo",
              fdamount as "fdAmount", rate, depdate as "depositDate", matdate as "maturityDate",
              matamount as "maturityAmount", interestamount as "interestAmount",
              lastintpaydate as "lastIntPayDate", intpaid as "interestPaid",
              interestpayamentmode as "intPaymentMode", interestbalance as "interestBalance",
              depperiod as "depositPeriod", depunit as "depositUnit", status
       FROM fdmaster WHERE mbno = $1 AND fdrdflag = 'F' AND status = '0'
       ORDER BY account_number`,
      [parseInt(memberNo)]
    );
    this.logger.log(`[FDInterest] Found ${result.length} active FDs for member ${memberNo}`);
    return result;
  }

  async getSavingAccountDetails(accountNo: string): Promise<{ success: boolean; data: any }> {
    try {
      this.logger.log(`[SavingAccount] Getting details for account: ${accountNo}`);

      // Get account balance and details from sbmaster
      const accountResult = await this.dataSource.query(
        `SELECT 
          acc_no as "accountNo",
          mbno as "memberNo",
          balance as "currentBalance",
          min_balance as "minimumBalance",
          unpass_cr as "unpassCr",
          unpass_dr as "unpassDr",
          (balance + COALESCE(unpass_cr, 0) - COALESCE(unpass_dr, 0)) as "availableBalance",
          (balance + COALESCE(unpass_cr, 0) - COALESCE(unpass_dr, 0) - COALESCE(min_balance, 0)) as "withdrawableBalance",
          mode_of_operation as "modeOfOperation",
          operators
        FROM sbmaster 
        WHERE acc_no = $1`,
        [accountNo]
      );

      if (!accountResult || accountResult.length === 0) {
        return { success: false, data: null };
      }

      const account = accountResult[0];

      // Get recent transaction history (last 10 transactions)
      const historyResult = await this.dataSource.query(
        `SELECT 
          TO_CHAR(trans_date, 'DD-Mon-YYYY') as "transDate",
          receipt_vchr_no as "voucherNo",
          acc_type as "accType",
          trans_type as "transType",
          trans_amt as "amount"
        FROM ledger 
        WHERE acc_no = $1 AND acc_type = 'SB'
        ORDER BY trans_date DESC, trans_no DESC
        LIMIT 10`,
        [accountNo]
      );

      account.transactionHistory = historyResult || [];

      this.logger.log(`[SavingAccount] Found account ${accountNo} with balance ${account.currentBalance}`);
      return { success: true, data: account };
    } catch (error) {
      this.logger.error(`[SavingAccount] Failed to get account details:`, error);
      throw new Error(`Failed to get account details: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async postFdInterestVoucher(
    data: {
      memberNo: number;
      accountNumber: number;
      certNo: string;
      interestAmount: number;
      transDate: string;
      narration?: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[FDInterest] Posting interest for FD ${data.accountNumber} amount=${data.interestAmount}`);

      // Get next trans_no and ledgerid
      await lockLedgerIds(queryRunner); // ES-445
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // ES-56: shared generator (locks the counter row and skips numbers that already exist)
      const voucherNo = await generateVoucherNo(queryRunner, 'J');

      const transDate = data.transDate ? new Date(data.transDate) : new Date();

      // CR A003 (FD liability) — interest accrued increases the member's FD balance
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', 'A003', $3, $4, 'FD', $5, $6, 'J', 'C', 0, $7, $8, $9)`,
        [nextTransNo, transDate, data.memberNo, data.accountNumber, data.interestAmount, voucherNo, data.narration || 'FD Interest Credit', username, nextLedgerId]
      );

      // DR Interest on FD (expense head) — balancing debit to record the expense
      const fdInterestExpenseHead = await queryRunner.query(
        `SELECT COALESCE(fdinthead, 'L1028') as head FROM busrules ORDER BY appdate DESC LIMIT 1`
      );
      const intExpenseCode = fdInterestExpenseHead[0]?.head || 'L1028';
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', $3, $4, $5, 'FD', $6, $7, 'J', 'C', 0, $8, $9, $10)`,
        [nextTransNo + 1, transDate, intExpenseCode, data.memberNo, data.accountNumber, data.interestAmount, voucherNo, data.narration || 'FD Interest Expense', username, nextLedgerId + 1]
      );

      // Update fdmaster: set lastintpaydate and add to intpaid
      await queryRunner.query(
        `UPDATE fdmaster SET lastintpaydate = $1, intpaid = COALESCE(intpaid, 0) + $2
         WHERE account_number = $3`,
        [transDate, data.interestAmount, data.accountNumber]
      );

      await queryRunner.commitTransaction();
      this.logger.log(`[FDInterest] Posted vchr=${voucherNo} FD=${data.accountNumber} amount=${data.interestAmount}`);

      return { success: true, transNo: nextTransNo, voucherNo, message: `Interest voucher ${voucherNo} posted. Amount: ${data.interestAmount}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[FDInterest] Failed:`, error);
      throw new Error(`Failed to post FD interest: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async createFixedDepositReceipt(
    data: {
      memberNo: number;
      prefix?: string;
      firstName?: string;
      middleName?: string;
      lastName?: string;
      certificateNo?: string;
      rate: number;
      depositPeriod: number;
      depositUnit: number;
      depositAmount: number;
      maturityAmount: number;
      depositDate: string;
      maturityDate: string;
      modeOfPayment: number;
      intAmount?: number;
      intCalMethod?: number;
      headCode?: string;
      nomineeName?: string;
      nomineeAge?: string;
      nomineeAddress?: string;
      nomineeRelation?: string;
      paymentMode: string;
      chequeNo?: string;
      bankName?: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; accountNumber: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[FDReceipt] Creating FD for member ${data.memberNo} amount=${data.depositAmount}`);

      // Get next account number for FD
      const maxAccResult = await queryRunner.query(
        `SELECT COALESCE(MAX(account_number), 500000) + 2 AS next_acc FROM fdmaster WHERE fdrdflag = 'F'`
      );
      const accountNumber = Number(maxAccResult[0]?.next_acc ?? 500001);

      // Get next trans_no and ledgerid
      await lockLedgerIds(queryRunner); // ES-445
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // ES-56: shared generator (locks the counter row and skips numbers that already exist)
      const voucherNo = await generateVoucherNo(queryRunner, 'R');

      const depDate = data.depositDate ? new Date(data.depositDate) : new Date();
      const matDate = data.maturityDate ? new Date(data.maturityDate) : new Date();
      const modeOfPay = data.paymentMode === 'bank' ? 'B' : 'C';

      // Insert into fdmaster
      await queryRunner.query(
        `INSERT INTO fdmaster (mbno, account_number, prefix, f_name, m_name, l_name, certno, depunit, depperiod, rate, depdate, matdate, fdamount, matamount, interestbalance, interestpayamentmode, interestamount, intpaid, status, nominee, nage, naddr, nrelation, fdrdflag, remarks, openbal, operationmode, intcalmethod, headcode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15, $16, 0, '0', $17, $18, $19, $20, 'F', '', 0, 1, $21, $22)`,
        [
          data.memberNo, accountNumber,
          data.prefix || '', data.firstName || '', data.middleName || '', data.lastName || '',
          data.certificateNo || `FD${accountNumber}`,
          data.depositUnit || 1, data.depositPeriod || 12,
          data.rate, depDate, matDate,
          data.depositAmount, data.maturityAmount,
          data.modeOfPayment || 1, data.intAmount || 0,
          data.nomineeName || '', data.nomineeAge || '', data.nomineeAddress || '', data.nomineeRelation || '',
          data.intCalMethod || 1, data.headCode || 'A003'
        ]
      );

      // CR A003 (FD liability account) — deposit received increases society's liability
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', $3, $4, $5, 'FD', $6, $7, 'R', $8, 0, 'Fixed Deposit Opening', $9, $10)`,
        [nextTransNo, depDate, data.headCode || 'A003', data.memberNo, accountNumber, data.depositAmount, voucherNo, modeOfPay, username, nextLedgerId]
      );

      // DR cash/bank — the asset (cash received) must increase to balance the entry
      const cashCode = modeOfPay === 'B' ? 'A1008' : 'A1001';
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', $3, $4, 0, 'CINH', $5, $6, 'R', $7, 0, 'Fixed Deposit Opening - Cash/Bank', $8, $9)`,
        [nextTransNo + 1, depDate, cashCode, data.memberNo, data.depositAmount, voucherNo, modeOfPay, username, nextLedgerId + 1]
      );

      await queryRunner.commitTransaction();
      this.logger.log(`[FDReceipt] Created FD account=${accountNumber} vchr=${voucherNo} member=${data.memberNo}`);

      return { success: true, accountNumber, voucherNo, message: `FD account ${accountNumber} created. Voucher: ${voucherNo}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[FDReceipt] Failed:`, error);
      throw new Error(`Failed to create FD: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async getPendingDividends(memberNo: string): Promise<any[]> {
    this.logger.log(`[Dividend] Getting pending dividends for member ${memberNo}`);
    // A dividend already credited into the member's Share Value (see
    // DividendCreditService) must never also show up here for cash payment
    // -- crediting and cash payment are mutually exclusive outcomes for the
    // same dividend_master row.
    const result = await this.dataSource.query(
      `SELECT id, mbno, year, share_amount as "shareAmount", dividend_rate as "dividendRate",
              dividend_amount as "dividendAmount", is_paid as "isPaid", voucher_no as "voucherNo"
       FROM dividend_master
       WHERE mbno = $1 AND (is_paid IS NULL OR is_paid = 'N') AND credited_at IS NULL
       ORDER BY year DESC`,
      [memberNo]
    );
    this.logger.log(`[Dividend] Found ${result.length} pending dividends for member ${memberNo}`);
    return result;
  }

  async processDividendPayment(
    data: {
      memberNo: string;
      dividendIds: number[];
      totalAmount: number;
      paymentMode: string;
      chequeNo?: string;
      chequeDate?: string;
      bankName?: string;
      narration?: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; voucherNo: string; message: string }> {
    // ES-449: the request is checked BEFORE anything is read or written. Before, an empty id list with any amount (even a
    // negative one) was posted as a balanced voucher, and a dividend that was already paid could be paid again.
    const body: any = data ?? {};
    const memberNoText = String(body.memberNo ?? '').trim();
    if (!/^\d+$/.test(memberNoText) || Number(memberNoText) <= 0) throw new BadRequestException('memberNo must be a valid member number.');
    const idList: number[] = Array.isArray(body.dividendIds) ? body.dividendIds.map((x: any) => Number(x)) : [];
    if (idList.length === 0 || idList.some((x) => !Number.isInteger(x) || x <= 0)) {
      throw new BadRequestException('Select at least one dividend to pay (dividendIds must be a list of valid ids).');
    }
    if (new Set(idList).size !== idList.length) throw new BadRequestException('dividendIds contains the same dividend twice.');
    const paymentTotal = typeof body.totalAmount === 'string' ? (body.totalAmount.trim() === '' ? NaN : Number(body.totalAmount)) : body.totalAmount;
    if (typeof paymentTotal !== 'number' || !Number.isFinite(paymentTotal) || paymentTotal <= 0) {
      throw new BadRequestException('totalAmount must be a number greater than 0.');
    }
    if (paymentTotal > 999_999_999.99) throw new BadRequestException('totalAmount is too large.');
    if (Math.abs(Math.round(paymentTotal * 100) - paymentTotal * 100) > 1e-6) throw new BadRequestException('totalAmount can have at most 2 decimals.');
    data = { ...data, totalAmount: paymentTotal };

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[Dividend] Processing payment for member ${data.memberNo} amount=${data.totalAmount}`);

      // ES-449: lock the selected dividend rows and make the payment match them exactly: every row must belong to this
      // member, be unpaid and not credited to Share Value, and the amount must equal their sum (the client amount is
      // never trusted on its own).
      const pending = await queryRunner.query(
        `SELECT id, dividend_amount FROM dividend_master
          WHERE id = ANY($1::int[]) AND mbno = $2 AND credited_at IS NULL AND (is_paid IS NULL OR is_paid <> 'Y')
          FOR UPDATE`,
        [idList, memberNoText],
      );
      if (pending.length !== idList.length) {
        throw new BadRequestException(
          `${idList.length - pending.length} of the ${idList.length} selected dividend(s) are not payable: already paid, already credited to Share Value, or not this member's. Refresh and try again.`,
        );
      }
      const pendingTotal = Math.round(pending.reduce((s: number, r: any) => s + Number(r.dividend_amount), 0) * 100) / 100;
      if (Math.abs(pendingTotal - paymentTotal) > 0.005) {
        throw new BadRequestException(`totalAmount ${paymentTotal} does not match the selected dividends (${pendingTotal}).`);
      }

      // Get next trans_no and ledgerid (ES-445: shared ledger id lock first)
      await lockLedgerIds(queryRunner);
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // ES-56: shared generator (locks the counter row and skips numbers that already exist)
      const voucherNo = await generateVoucherNo(queryRunner, 'R');

      const transDate = new Date();
      await assertPostingDateOpen(queryRunner, transDate); // ES-458
      const modeOfPay = data.paymentMode === 'bank' ? 'B' : 'C';
      const memberNoInt = parseInt(data.memberNo);

      // DR L1024 (Dividend Paid) — OTH
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', 'L1024', $3, 0, 'OTH', $4, $5, 'P', $6, 0, $7, $8, $9)`,
        [nextTransNo, transDate, memberNoInt, data.totalAmount, voucherNo, modeOfPay, data.narration || 'Dividend Payment', username, nextLedgerId]
      );

      // BUG FIX: Missing balancing CR to cash/bank (double-entry bookkeeping).
      // Dividend is paid OUT → DR Dividend expense (L1024) + CR Cash/Bank.
      // Previously only the DR side was inserted, leaving the ledger permanently unbalanced.
      const crCode    = modeOfPay === 'B' ? 'A1008' : 'A1001';  // bank or cash
      const crAccType = modeOfPay === 'B' ? 'BANK'  : 'CINH';

      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', $3, $4, 0, $5, $6, $7, 'P', $8, 0, $9, $10, $11)`,
        [nextTransNo + 1, transDate, crCode, memberNoInt, crAccType, data.totalAmount, voucherNo, modeOfPay, data.narration || 'Dividend Payment', username, nextLedgerId + 1]
      );

      // Mark dividends as paid -- excludes any row already credited into
      // Share Value (see DividendCreditService), so cash payment and Share
      // credit can never both apply to the same dividend. The ledger DR/CR
      // above was already posted for the full requested amount, so if fewer
      // rows actually update than were requested (one got credited
      // concurrently), that mismatch must roll back the whole payment
      // rather than silently pay out cash for a dividend no longer pending.
      if (data.dividendIds && data.dividendIds.length > 0) {
        const updateResult = await queryRunner.query(
          `UPDATE dividend_master SET is_paid = 'Y', payment_date = $1, payment_mode = $2, cheque_no = $3, voucher_no = $4
           WHERE id = ANY($5) AND credited_at IS NULL AND (is_paid IS NULL OR is_paid <> 'Y')
           RETURNING id`,
          [transDate, data.paymentMode, data.chequeNo || '', voucherNo, data.dividendIds]
        );
        // queryRunner.query() for a non-SELECT returns [rows[], rowCount],
        // never a plain rows array -- updateResult[0] is the actual RETURNING
        // rows (see the same gotcha already flagged in
        // pass-transaction.service.ts:201).
        const updatedRows = updateResult[0];
        if (updatedRows.length !== data.dividendIds.length) {
          throw new Error(
            `${data.dividendIds.length - updatedRows.length} of ${data.dividendIds.length} selected dividend(s) were already credited to Share Value and can no longer be paid as cash. Please refresh and try again.`,
          );
        }
      }

      await queryRunner.commitTransaction();
      this.logger.log(`[Dividend] Paid vchr=${voucherNo} member=${data.memberNo} amount=${data.totalAmount} crCode=${crCode}`);

      return { success: true, voucherNo, message: `Dividend payment ${voucherNo} processed. Amount: ${data.totalAmount}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[Dividend] Failed:`, error);
      if (error instanceof HttpException) throw error; // ES-449: a clear 400 stays a 400
      throw new Error(`Failed to process dividend: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Input check for the screens that post straight to the ledger (Receipt, Voucher Payment, Receipt voucher). (ES-359)
   * An empty or junk body used to give HTTP 500, or - for the payment voucher - a success with nothing in it.
   */
  /** The working date as YYYY-MM-DD (null when Day-End has no open day): shown on the voucher windows, which can not change it */
  async getWorkingDate(): Promise<{ date: string | null }> {
    return { date: await getWorkingDateText(this.dataSource) };
  }

  /** The date a window will put on its entries now (its Date setting: working date or system date); shown on the window's calendar. */
  async getPostingDate(windowKey: string): Promise<{ date: string; mode: 'WORKING' | 'SYSTEM' }> {
    const key = String(windowKey ?? '').trim();
    if (!key || key.length > 80) throw new BadRequestException('A window key is needed.');
    const { date, mode } = await resolvePostingDate(this.dataSource, key);
    return { date, mode };
  }

  async assertVoucherInput(data: any): Promise<void> {
    if (!data || typeof data !== 'object') throw new BadRequestException('Request body is required.');

    // General receipt / general payment: not tied to a member (member number 0)
    const isGeneral = data.receiptType === 'general' || data.paymentType === 'general';
    const memberNo = Number(data.memberNo ?? 0);
    if (isGeneral) {
      if (data.memberNo !== undefined && data.memberNo !== null && data.memberNo !== '' && memberNo !== 0) {
        throw new BadRequestException('A general receipt / payment is not for a member: leave the member number empty (0).');
      }
    } else {
      if (!Number.isInteger(memberNo) || memberNo <= 0) throw new BadRequestException('Member number must be a valid member number.');
      const member = await this.dataSource.query(`SELECT 1 FROM member_master WHERE mbno = $1`, [memberNo]);
      if (member.length === 0) throw new BadRequestException(`Member ${memberNo} does not exist.`);
    }

    if (data.transDate) {
      const d = new Date(data.transDate);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('transDate is not a valid date.');
      // ES-609: a voucher can not be dated in the future (it would post ahead of the working date)
      const todayStr = new Date().toISOString().slice(0, 10);
      if (String(data.transDate).slice(0, 10) > todayStr) throw new BadRequestException('The voucher date can not be in the future.');
    }

    // ES-610: narration is stored in a 100-character column
    if (data.narration !== undefined && data.narration !== null && String(data.narration).length > 100) {
      throw new BadRequestException('Narration can be at most 100 characters.');
    }

    // ES-609: mode of payment must be cash (C) or bank (B)
    if (data.modeOfPay !== undefined && data.modeOfPay !== null && data.modeOfPay !== '') {
      const mode = String(data.modeOfPay).toUpperCase();
      if (mode !== 'C' && mode !== 'B') throw new BadRequestException('Mode of payment must be C (cash) or B (bank).');
      data.modeOfPay = mode;
    }

    // ES-609: a bank / cheque payment needs a cheque number, and the account must really be a bank account
    const bankHead = String(data.bankCode ?? data.receiveIntoCode ?? data.payFromCode ?? '').trim();
    const isBankMode = data.modeOfPay === 'B' || (data.payFromCode !== undefined && bankHead !== '' && bankHead !== 'A1001');
    if (data.modeOfPay === 'B' && data.receiptType !== undefined && !String(data.cheqNo ?? '').trim()) {
      throw new BadRequestException('Enter the cheque number for a bank / cheque receipt.');
    }
    if (isBankMode && bankHead) {
      const banks = await this.dataSource.query(
        `SELECT 1 FROM headmaster WHERE TRIM(code) = $1 AND (UPPER(head_name) LIKE '%BANK%' OR UPPER(head_name) LIKE '%ACCOUNT%') LIMIT 1`, [bankHead]);
      if (banks.length === 0) throw new BadRequestException(`${bankHead} is not a bank account head.`);
    }

    // ES-610: a manual voucher number that already exists is refused clearly
    const manualNo = String(data.voucherNo ?? '').trim();
    if (manualNo) {
      if (manualNo.length > 20) throw new BadRequestException('Voucher number can be at most 20 characters.');
      const dup = await this.dataSource.query(`SELECT 1 FROM vouchers WHERE "voucherNumber" = $1 LIMIT 1`, [manualNo]);
      if (dup.length > 0) throw new BadRequestException(`Voucher number ${manualNo} already exists.`);
    }

    if (!Array.isArray(data.rows) || data.rows.length === 0) throw new BadRequestException('At least one row is required.');
    const codes = new Set<string>();
    data.rows.forEach((row: any, i: number) => {
      const amount = Number(row?.amount);
      if (!row || typeof row.code !== 'string' || !row.code.trim()) throw new BadRequestException(`Row ${i + 1}: head code is required.`);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) throw new BadRequestException(`Row ${i + 1}: amount must be a number greater than 0.`);
      if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) throw new BadRequestException(`Row ${i + 1}: amount can have at most 2 decimals.`);
      row.amount = amount;
      row.code = row.code.trim();
      // ES-609: every row carries an account type (from the head when the screen did not send one)
      if (!row.accType || !String(row.accType).trim()) row.accType = ACC_TYPE_BY_HEAD[row.code] || 'OTH';
      // ES-611: the RD serial number typed on a row (digits only)
      if (row.rdSrNo !== undefined && row.rdSrNo !== null && String(row.rdSrNo).trim() !== '' && !/^\d{1,9}$/.test(String(row.rdSrNo).trim())) {
        throw new BadRequestException(`Row ${i + 1}: RD Sr.No must be a number.`);
      }
      codes.add(row.code);
    });
    const known = await this.dataSource.query(`SELECT TRIM(code) AS code FROM headmaster WHERE TRIM(code) = ANY($1)`, [[...codes]]);
    const knownSet = new Set(known.map((h: any) => h.code));
    const unknown = [...codes].filter(c => !knownSet.has(c));
    if (unknown.length > 0) throw new BadRequestException(`Unknown head code(s): ${unknown.join(', ')}`);
  }

  /** Input check for the legacy Loan Entry screen. (ES-359) */
  async assertLoanEntryInput(data: any): Promise<void> {
    if (!data || typeof data !== 'object') throw new BadRequestException('Request body is required.');
    const memberNo = Number(data.memberNo);
    if (!Number.isInteger(memberNo) || memberNo <= 0) throw new BadRequestException('memberNo must be a valid member number.');
    const member = await this.dataSource.query(`SELECT 1 FROM member_master WHERE mbno = $1`, [memberNo]);
    if (member.length === 0) throw new BadRequestException(`Member ${memberNo} does not exist.`);
    const amount = Number(data.loanAmount), rate = Number(data.rate), n = Number(data.noOfInstal);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) throw new BadRequestException('loanAmount must be a number greater than 0.');
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new BadRequestException('rate must be a number from 0 to 100.');
    if (!Number.isInteger(n) || n < 1 || n > 600) throw new BadRequestException('noOfInstal must be a whole number from 1 to 600.');
    if (data.paymentDate && Number.isNaN(new Date(data.paymentDate).getTime())) throw new BadRequestException('paymentDate is not a valid date.');
  }

  /**
   * Receipt window. Like every other voucher it is only STAGED here (CR line per head, DR line for the cash / bank
   * account, and a PENDING voucher header) and reaches the ledger and the Cash Book when it is passed in Pass
   * Transactions. It used to post straight to the ledger (and stamped the cash line as a Payment).
   */
  async saveReceipt(
    data: {
      memberNo: number;
      voucherNo: string;
      transDate: string;
      modeOfPay: string;
      bankCode: string;   // which bank to DR (A1008 etc.)
      narration: string;
      cheqNo?: string;
      cheqDate?: string;
      /** the customer's bank (cheque drawn on) */
      bankName?: string;
      receiptType?: string;
      month?: string;
      year?: string | number;
      rows: Array<{ code: string; accType: string; amount: number; rdSrNo?: string }>;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    return this.saveReceiptVoucher({
      ...(data.receiptType !== undefined ? { receiptType: data.receiptType } : {}),
      ...(data.month !== undefined ? { month: data.month } : {}),
      ...(data.year !== undefined ? { year: data.year } : {}),
      memberNo: data.receiptType === 'general' ? 0 : data.memberNo,
      voucherNo: data.voucherNo,
      transDate: data.transDate,
      modeOfPay: data.modeOfPay || 'C',
      narration: data.narration,
      ...(data.cheqNo !== undefined ? { cheqNo: data.cheqNo } : {}),
      ...(data.cheqDate !== undefined ? { cheqDate: data.cheqDate } : {}),
      ...(data.bankName !== undefined ? { bankName: data.bankName } : {}),
      receiveIntoCode: data.bankCode || 'A1001',
      rows: data.rows,
    }, username);
  }

  async saveReceiptVoucher(
    data: {
      memberNo: number;
      voucherNo: string;
      transDate: string;
      modeOfPay: string;
      narration: string;
      cheqNo?: string;
      cheqDate?: string;
      bankName?: string;
      /** Our bank/cash head to debit. Used in bank mode; cash mode always debits A1001. */
      receiveIntoCode?: string;
      /** Receipt window: 'receipt' | 'general' | 'demand'. Recorded on the voucher so a demand receipt can be told apart. */
      receiptType?: string;
      /** Demand receipt: the demand month (e.g. NOV) and year it is for. */
      month?: string;
      year?: string | number;
      rows: Array<{ code: string; accType: string; amount: number; rdSrNo?: string }>;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[VoucherPayment] Saving to TRANSACTIONS for member ${data.memberNo} rows=${data.rows.length}`);

      // Get next trans_no for transactions table (ES-495: under the one shared lock, like every other writer)
      // lock order matches the voucher service (vouchers first, then transactions) so the two can not deadlock
      await lockNextId(queryRunner, 'vouchers', 'id');
      await lockNextId(queryRunner, 'transactions', 'trans_no');
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no FROM transactions`
      );
      let nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);

      // Demand Receipt (by hand): a receipt against ONE member's demand for ONE month. It is a D voucher (the legacy
      // keeps these in its own Demand_receipt table), and the member's demand for that month must not already be paid.
      const isDemand = data.receiptType === 'demand';
      const demandMonthNo = isDemand ? UtilitiesService.monthNumber(data.month) : 0;
      const demandYear = isDemand ? Number(data.year) : 0;
      if (isDemand) {
        if (!data.memberNo) throw new BadRequestException('A demand receipt is for a member: select the member.');
        if (!demandMonthNo) throw new BadRequestException('Choose the demand month (JAN to DEC).');
        if (!Number.isInteger(demandYear) || demandYear < 2000 || demandYear > 2100) throw new BadRequestException('Choose a valid demand year.');
        const posted = await queryRunner.query(
          `SELECT 1 FROM demand_master WHERE mbno = $1 AND demand_for_year = $2 AND demand_for_month = $3 AND COALESCE(demand_posted, 'N') = 'Y' LIMIT 1`,
          [data.memberNo, demandYear, demandMonthNo]);
        if (posted.length > 0) {
          throw new BadRequestException(`Member ${data.memberNo}'s demand for ${String(data.month).toUpperCase()} ${demandYear} is already posted.`);
        }
        const pending = await queryRunner.query(
          `SELECT "voucherNumber" FROM vouchers WHERE status = 'PENDING' AND "memberId" = $1 AND remarks LIKE $2 LIMIT 1`,
          [data.memberNo, `%DEMAND_MONTH:${String(data.month).toUpperCase()}|DEMAND_YEAR:${demandYear}%`]);
        if (pending.length > 0) {
          throw new BadRequestException(`Member ${data.memberNo} already has a pending demand receipt (${pending[0].voucherNumber}) for ${String(data.month).toUpperCase()} ${demandYear}. Pass or delete it first.`);
        }
      }
      const vchrKind: 'R' | 'D' = isDemand ? 'D' : 'R';

      // Generate R voucher number if not provided (uses R_VCHR_NO from voucher_master)
      let voucherNo = data.voucherNo;
      if (!voucherNo) {
        // ES-56: shared generator (locks the counter row and skips numbers that already exist)
        voucherNo = await generateVoucherNo(queryRunner, vchrKind);
      }

      // Dated by the client's Date setting for this window (Day End > Date settings): the Day-End WORKING date by default,
      // or the real date of the day. Never the computer clock of the PC and never a date sent by the screen.
      const posting = await resolvePostingDate(queryRunner, 'RECEIPT_PAYMENT');
      const transDate = postingDateAsDate(posting.date);
      await assertPostingDateOpen(queryRunner, transDate); // ES-458
      const totalAmount = data.rows.reduce((s, r) => s + r.amount, 0);
      const modeOfPay = data.modeOfPay || 'C';

      // DR cash/bank received increases the asset. ES-50: this was hard-coded to A1001, so a bank-mode
      // receipt debited Cash in Hand and never reached the bank head the user chose.
      const isBankMode = String(modeOfPay).toUpperCase() === 'B';
      const drCode = isBankMode ? (data.receiveIntoCode || 'A1001') : 'A1001';
      const drAccType = drCode === 'A1001' ? 'CINH' : 'BANK';
      await queryRunner.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, cheq_no, cheq_amt, cheq_date, bankname, pass_flag, cashier_flag, code, narration, username)
         VALUES ($1, 'DR', $2, $3, 0, $12, $4, $5, '${vchrKind}', $6, $7, 0, $8, $9, 'N', 'Y', $13, $10, $11)`,
        [nextTransNo++, transDate, data.memberNo, totalAmount, voucherNo, modeOfPay,
         data.cheqNo || '', data.cheqDate ? new Date(data.cheqDate) : null, data.bankName || '',
         data.narration || '', username, drAccType, drCode]
      );

      // CR each row (loan recovery, interest income, etc.) — credit the income/liability accounts
      for (const row of data.rows) {
        if (!row.code || !row.amount) continue;
        await queryRunner.query(
          `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, cheq_no, cheq_amt, cheq_date, bankname, pass_flag, cashier_flag, code, narration, username)
           VALUES ($1, 'CR', $2, $3, $14, $4, $5, $6, '${vchrKind}', $7, $8, 0, $9, $10, 'N', 'Y', $11, $12, $13)`,
          [nextTransNo++, transDate, data.memberNo || 0, row.accType || ACC_TYPE_BY_HEAD[row.code] || 'OTH', row.amount, voucherNo, modeOfPay,
           data.cheqNo || '', data.cheqDate ? new Date(data.cheqDate) : null, data.bankName || '',
           row.code, data.narration || '', username,
           // ES-611: the RD serial number typed on the row is the account number of that line
           /^\d+$/.test(String(row.rdSrNo ?? '').trim()) ? Number(String(row.rdSrNo).trim()) : 0]
        );
      }

      // ES-55: create the voucher HEADER too. Pass Transactions lists and passes only from `vouchers`
      // (status PENDING), so staged rows with no header could never be listed or passed.
      await lockNextId(queryRunner, 'vouchers', 'id'); // ES-495: same key as the voucher service
      const nextVoucherId = Number((await queryRunner.query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM vouchers`))[0].n);
      await queryRunner.query(
        `INSERT INTO vouchers ("id","voucherNumber","voucherDate","voucherType","totalAmount","description","memberId","payeeName",
                               "status","remarks","chequeNumber","chequeDate","bankName","createdAt")
         VALUES ($1,$2,$3,'RECEIPT',$4,$5,$6,'','PENDING',$7,$8,$9,$10,NOW())`,
        [nextVoucherId, voucherNo, transDate, totalAmount, data.narration || 'Receipt voucher',
         data.memberNo || null,
         // ES-611: the kind of receipt (and the demand month / year) travel with the voucher
         `VOUCHER_PAYMENT|PAY_MODE:${isBankMode ? 'BANK' : 'CASH'}` +
           (data.receiptType && data.receiptType !== 'receipt' ? `|RECEIPT_TYPE:${String(data.receiptType).toUpperCase()}` : '') +
           (data.receiptType === 'demand' && data.month && data.year ? `|DEMAND_MONTH:${String(data.month).toUpperCase()}|DEMAND_YEAR:${data.year}` : ''),
         data.cheqNo || null, data.cheqDate ? new Date(data.cheqDate) : null,
         // Pass treats a voucher with a bank name or cheque number as a transfer (not cash); keep bank mode intact.
         data.bankName || (isBankMode ? drCode : null)]
      );

      await queryRunner.commitTransaction();
      this.logger.log(`[VoucherPayment] Saved vchr=${voucherNo} member=${data.memberNo} total=${totalAmount} rows=${data.rows.length} → TRANSACTIONS (pass_flag=N) + voucher header (PENDING)`);

      return { success: true, transNo: nextTransNo - data.rows.length - 1, voucherNo, message: `Voucher ${voucherNo} staged in TRANSACTIONS (pending pass). Total: ${totalAmount}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[VoucherPayment] Failed:`, error);
      if (error instanceof HttpException) throw error; // a clear 400 (closed day / closed year) stays a 400
      throw new Error(`Failed to save voucher payment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }


  /**
   * Payment voucher (Voucher Creation), step 1 of 3: Voucher Creation -> Voucher Payment (cashier signs) -> Pass Transactions.
   * It only STAGES the debit line of each head and a PENDING header marked "SIGN:PENDING". There is no cash / bank line
   * yet: the cashier chooses cash or bank in Voucher Payment, and that step adds it. Nothing reaches the ledger, the Cash
   * Book or any balance until the voucher is signed and then passed in Pass Transactions.
   */
  async savePaymentVoucher(
    data: {
      memberNo: number;
      voucherNo: string;
      transDate: string;
      paymentType: string;
      officeNo?: string;
      narration: string;
      rows: Array<{ code: string; name: string; amount: number; rdSrNo?: string }>;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[PaymentVoucher] Staging payment for member ${data.memberNo} rows=${data.rows?.length}`);

      // same lock order as the receipt voucher: vouchers first, then transactions
      await lockNextId(queryRunner, 'vouchers', 'id');
      await lockNextId(queryRunner, 'transactions', 'trans_no');
      let nextTransNo = Number((await queryRunner.query(`SELECT COALESCE(MAX(trans_no), 0) + 1 AS n FROM transactions`))[0]?.n ?? 1);

      let voucherNo = data.voucherNo;
      if (!voucherNo) {
        // ES-56: shared generator (locks the counter row and skips numbers that already exist)
        voucherNo = await generateVoucherNo(queryRunner, 'P');
      }

      // Dated by the client's Date setting for this window (Day End > Date settings): the Day-End WORKING date by default,
      // or the real date of the day. Never the computer clock of the PC and never a date sent by the screen.
      const posting = await resolvePostingDate(queryRunner, 'RECEIPT_PAYMENT_VOUCHER_CREATION');
      const transDate = postingDateAsDate(posting.date);
      await assertPostingDateOpen(queryRunner, transDate); // ES-458
      const rows = (data.rows || []).filter(r => r.code && Number(r.amount) > 0);
      if (rows.length === 0) throw new BadRequestException('Add at least one row with a head and an amount.');
      const total = Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;
      const memberNo = data.paymentType === 'general' ? 0 : (data.memberNo || 0);
      const narration = data.narration || '';

      // DR one line per head being paid. cashier_flag 'N' until the cashier signs it in Voucher Payment.
      for (const row of rows) {
        await queryRunner.query(
          `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, cheq_no, cheq_amt, cheq_date, bankname, pass_flag, cashier_flag, code, narration, username)
           VALUES ($1, 'DR', $2, $3, $10, $4, $5, $6, 'P', '', '', 0, NULL, '', 'N', 'N', $7, $8, $9)`,
          [nextTransNo++, transDate, memberNo, ACC_TYPE_BY_HEAD[row.code] || 'OTH', Number(row.amount), voucherNo,
           row.code, (narration || row.name || '').slice(0, 100), username,
           /^\d+$/.test(String(row.rdSrNo ?? '').trim()) ? Number(String(row.rdSrNo).trim()) : 0],
        );
      }

      const nextVoucherId = Number((await queryRunner.query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM vouchers`))[0].n);
      await queryRunner.query(
        `INSERT INTO vouchers ("id","voucherNumber","voucherDate","voucherType","totalAmount","description","memberId","payeeName",
                               "status","remarks","chequeNumber","chequeDate","bankName","createdAt")
         VALUES ($1,$2,$3,'PAYMENT',$4,$5,$6,'','PENDING','VOUCHER_PAYMENT|SIGN:PENDING',NULL,NULL,NULL,NOW())`,
        [nextVoucherId, voucherNo, transDate, total, narration || 'Payment voucher', memberNo || null],
      );

      await queryRunner.commitTransaction();
      this.logger.log(`[PaymentVoucher] Staged vchr=${voucherNo} member=${memberNo} total=${total} rows=${rows.length} (waiting for the cashier)`);

      return { success: true, transNo: nextTransNo - rows.length, voucherNo, message: `Payment voucher ${voucherNo} saved. Open Voucher Payment, choose cash or bank and save it, then pass it. Total: ${total}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[PaymentVoucher] Failed:`, error);
      if (error instanceof HttpException) throw error; // ES-458
      throw new Error(`Failed to save payment voucher: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  /** Voucher Payment drop-down: payment vouchers created in Voucher Creation that have not been completed in Voucher Payment yet. */
  async listUnsignedPaymentVouchers(): Promise<any[]> {
    const rows = await this.dataSource.query(
      `SELECT v."voucherNumber" AS "voucherNo", v."voucherDate" AS "voucherDate", v."totalAmount" AS total, v."memberId" AS "memberNo",
              REGEXP_REPLACE(TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')), '\\s+', ' ', 'g') AS "memberName"
         FROM vouchers v LEFT JOIN member_master m ON m.mbno = v."memberId"
        WHERE v.status = 'PENDING' AND v."voucherType" = 'PAYMENT' AND COALESCE(v.remarks, '') LIKE '%|SIGN:PENDING%'
        ORDER BY v."createdAt" DESC, v."voucherNumber" DESC`);
    return rows.map((r: any) => ({ ...r, total: Number(r.total) }));
  }

  /** What the cashier sees after picking a voucher: member, the heads and amounts, narration. */
  async getPaymentVoucherForSign(voucherNo: string): Promise<any> {
    const head = await this.dataSource.query(
      `SELECT v."voucherNumber" AS "voucherNo", v."voucherDate" AS "voucherDate", v."totalAmount" AS total, v."memberId" AS "memberNo",
              v.description AS narration, v.remarks,
              REGEXP_REPLACE(TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')), '\\s+', ' ', 'g') AS "memberName",
              m.officeno AS "officeNo"
         FROM vouchers v LEFT JOIN member_master m ON m.mbno = v."memberId"
        WHERE v."voucherNumber" = $1 AND v."voucherType" = 'PAYMENT' AND v.status = 'PENDING'`, [voucherNo]);
    if (head.length === 0) throw new NotFoundException(`Payment voucher ${voucherNo} was not found or is no longer pending.`);
    if (!String(head[0].remarks || '').includes('|SIGN:PENDING')) throw new BadRequestException(`Voucher ${voucherNo} is already saved in Voucher Payment.`);
    const rows = await this.dataSource.query(
      `SELECT t.code, COALESCE(h.head_name, '') AS name, t.trans_amt AS amount, t.acc_no AS "rdSrNo"
         FROM transactions t LEFT JOIN headmaster h ON TRIM(h.code) = TRIM(t.code)
        WHERE t.receipt_vchr_no = $1 AND t.pass_flag = 'N' AND t.trans_type = 'DR' ORDER BY t.trans_no`, [voucherNo]);
    return {
      voucherNo: head[0].voucherNo, voucherDate: head[0].voucherDate, total: Number(head[0].total),
      memberNo: head[0].memberNo ? String(head[0].memberNo) : '0', memberName: head[0].memberName || '', officeNo: head[0].officeNo ?? '',
      isGeneral: !head[0].memberNo, narration: head[0].narration || '',
      rows: rows.map((r: any) => ({ code: String(r.code).trim(), name: r.name, amount: Number(r.amount), rdSrNo: Number(r.rdSrNo) > 0 ? String(r.rdSrNo) : '' })),
    };
  }

  /**
   * Voucher Payment, step 2 of 3 (the cashier's "Save"): choose cash or bank (with the cheque details), and the cash / bank
   * line that balances the voucher is added. The voucher then shows up in Pass Transactions.
   */
  async signPaymentVoucher(
    data: { voucherNo: string; modeOfPay: string; bankCode?: string; cheqNo?: string; cheqDate?: string; bankName?: string },
    username: string = 'system',
  ): Promise<{ success: boolean; voucherNo: string; message: string }> {
    const voucherNo = String(data?.voucherNo || '').trim();
    if (!voucherNo) throw new BadRequestException('Choose the voucher.');
    const mode = String(data.modeOfPay || '').toUpperCase();
    if (mode !== 'C' && mode !== 'B') throw new BadRequestException('Mode of payment must be C (cash) or B (bank).');
    const isCash = mode === 'C';
    const bankCode = String(data.bankCode || '').trim();
    if (!isCash) {
      if (!bankCode) throw new BadRequestException('Choose the bank account the payment is made from.');
      if (!String(data.cheqNo || '').trim()) throw new BadRequestException('Enter the cheque number for a bank / cheque payment.');
      const banks = await this.dataSource.query(
        `SELECT 1 FROM headmaster WHERE TRIM(code) = $1 AND (UPPER(head_name) LIKE '%BANK%' OR UPPER(head_name) LIKE '%ACCOUNT%') LIMIT 1`, [bankCode]);
      if (banks.length === 0) throw new BadRequestException(`${bankCode} is not a bank account head.`);
    }
    if (data.cheqDate && Number.isNaN(new Date(data.cheqDate).getTime())) throw new BadRequestException('The cheque date is not a valid date.');

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await lockNextId(queryRunner, 'transactions', 'trans_no');
      const head = await queryRunner.query(
        `SELECT * FROM vouchers WHERE "voucherNumber" = $1 AND "voucherType" = 'PAYMENT' AND status = 'PENDING' FOR UPDATE`, [voucherNo]);
      if (head.length === 0) throw new NotFoundException(`Payment voucher ${voucherNo} was not found or is no longer pending.`);
      if (!String(head[0].remarks || '').includes('|SIGN:PENDING')) throw new BadRequestException(`Voucher ${voucherNo} is already saved in Voucher Payment.`);
      await assertPostingDateOpen(queryRunner, new Date(head[0].voucherDate)); // ES-458

      const lines = await queryRunner.query(
        `SELECT trans_amt FROM transactions WHERE receipt_vchr_no = $1 AND pass_flag = 'N' AND trans_type = 'DR'`, [voucherNo]);
      if (lines.length === 0) throw new BadRequestException(`Voucher ${voucherNo} has no lines.`);
      const total = Math.round(lines.reduce((s: number, r: any) => s + Number(r.trans_amt), 0) * 100) / 100;

      const payCode = isCash ? 'A1001' : bankCode;
      const cheqDate = !isCash && data.cheqDate ? new Date(data.cheqDate) : null;
      const cheqNo = isCash ? '' : String(data.cheqNo).trim();
      const customerBank = isCash ? '' : String(data.bankName || '').trim().slice(0, 50);

      // the lines already staged take the chosen mode and cheque details, and are signed
      await queryRunner.query(
        `UPDATE transactions SET modeofpay = $2, cheq_no = $3, cheq_date = $4, bankname = $5, cashier_flag = 'Y'
          WHERE receipt_vchr_no = $1 AND pass_flag = 'N'`, [voucherNo, mode, cheqNo, cheqDate, customerBank]);
      const first = await queryRunner.query(`SELECT mbno, trans_date FROM transactions WHERE receipt_vchr_no = $1 ORDER BY trans_no LIMIT 1`, [voucherNo]);
      const nextTransNo = Number((await queryRunner.query(`SELECT COALESCE(MAX(trans_no), 0) + 1 AS n FROM transactions`))[0].n);
      // the balancing line: CR the account the money goes out of
      await queryRunner.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, cheq_no, cheq_amt, cheq_date, bankname, pass_flag, cashier_flag, code, narration, username)
         VALUES ($1, 'CR', $2, $3, 0, $4, $5, $6, 'P', $7, $8, 0, $9, $10, 'N', 'Y', $11, $12, $13)`,
        [nextTransNo, first[0].trans_date, first[0].mbno, isCash ? 'CINH' : 'BANK', total, voucherNo, mode, cheqNo, cheqDate, customerBank,
         payCode, String(head[0].description || '').slice(0, 100), username]);

      // the header now carries the payment mode (Pass treats a bank name / cheque number as a transfer)
      await queryRunner.query(
        `UPDATE vouchers SET remarks = $2, "chequeNumber" = $3, "chequeDate" = $4, "bankName" = $5 WHERE "voucherNumber" = $1`,
        [voucherNo, `VOUCHER_PAYMENT|PAY_MODE:${isCash ? 'CASH' : 'BANK'}`, cheqNo || null, cheqDate, isCash ? null : (customerBank || payCode)]);

      await queryRunner.commitTransaction();
      this.logger.log(`[PaymentVoucher] Completed vchr=${voucherNo} mode=${mode} from=${payCode} total=${total} by ${username}`);
      return { success: true, voucherNo, message: `Voucher ${voucherNo} saved in Voucher Payment. It is ready to be passed in Pass Transactions.` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof HttpException) throw error;
      this.logger.error(`[PaymentVoucher] Voucher Payment failed:`, error);
      throw new Error(`Failed to save the voucher: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async saveLoanEntry(
    data: {
      memberNo: number;
      loanType: string;
      loanAmount: number;
      rate: number;
      noOfInstal: number;
      instalAmt: number;
      paymentDate: string;
      purpose: string;
      penalRate: number;
      g1MbNo: number;
      g2MbNo: number;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; loanCaseNo: number; message: string }> {
    // A Loan Against RD must be secured by a lock on the member's RD, which is only placed (together
    // with the 90% / maximum-amount checks) when the loan goes through Loan Application, Sanction and
    // Pass Transactions. This screen writes the loan record directly and never reaches that code, so
    // it would create an unsecured loan the member could walk away from by withdrawing the RD.
    if ((data.loanType || '').toUpperCase() === 'ELN') {
      throw new BadRequestException(
        'Loan Against RD cannot be entered here, because this screen cannot lock the member\'s RD. ' +
        'Enter it through Loan Application, then sanction and pay it out.',
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[LoanEntry] Saving ${data.loanType} loan for member ${data.memberNo}`);

      // Get next loancaseno
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(loancaseno), 0) + 1 AS next_case FROM loan_master`
      );
      const loanCaseNo = Number(maxResult[0]?.next_case ?? 1);

      const payDate = data.paymentDate ? new Date(data.paymentDate) : new Date();

      // Insert into loan_master
      // BUG FIX: openbalance was hardcoded to 0 — should equal loanAmount (original sanctioned amount)
      await queryRunner.query(
        `INSERT INTO loan_master (mbno, loantype, loancaseno, loan_amt, payment_date, rate, no_of_instal, instal_amt, balance, openbalance, purpose, intt_amount, penalrate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12)`,
        [
          data.memberNo, data.loanType, loanCaseNo, data.loanAmount,
          payDate, data.rate, data.noOfInstal, data.instalAmt,
          data.loanAmount, // balance = loan amount initially
          data.loanAmount, // openbalance = original sanctioned amount (for amortization/reconciliation)
          data.purpose || '', data.penalRate || 0
        ]
      );

      // Insert/update suretymaster if guarantors provided
      if (data.g1MbNo || data.g2MbNo) {
        // Check if surety record exists for this member
        const existing = await queryRunner.query(
          `SELECT mbno FROM suretymaster WHERE mbno = $1`, [data.memberNo]
        );
        if (existing.length > 0) {
          await queryRunner.query(
            `UPDATE suretymaster SET g1mbno = $1, g2mbno = $2 WHERE mbno = $3`,
            [data.g1MbNo || 0, data.g2MbNo || 0, data.memberNo]
          );
        } else {
          await queryRunner.query(
            `INSERT INTO suretymaster (mbno, amount, g1mbno, g2mbno, g1amt, g2amt, addflag)
             VALUES ($1, 0, $2, $3, 0, 0, 'N')`,
            [data.memberNo, data.g1MbNo || 0, data.g2MbNo || 0]
          );
        }
      }

      await queryRunner.commitTransaction();
      this.logger.log(`[LoanEntry] Saved loan_master loancaseno=${loanCaseNo} type=${data.loanType} member=${data.memberNo}`);

      return { success: true, loanCaseNo, message: `${data.loanType} loan saved. Case No: ${loanCaseNo}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[LoanEntry] Failed:`, error);
      throw new Error(`Failed to save loan: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async saveFdRdSbEntry(
    data: {
      entryType: 'FD' | 'RD' | 'SB';
      memberNo: number;
      accountNo: number;
      transDate: string;
      transType: 'CR' | 'DR';
      amount: number;
      receiptVchrNo: string;
      vchrType: string;
      modeOfPay: string;
      narration: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[FdRdSbEntry] Saving ${data.entryType} entry for member ${data.memberNo}`);

      // Legacy mapping: FD→CD (L1004), RD→MD (L1002), SB→MD1 (L1045)
      // acc_type and head code follow the legacy ledger pattern exactly
      const typeMap: Record<string, { accType: string; code: string }> = {
        FD: { accType: 'CD',  code: 'L1004' },  // Compulsory Deposit
        RD: { accType: 'MD',  code: 'L1002' },  // Monthly Deposit (FRS 1)
        SB: { accType: 'MD1', code: 'L1045' },  // Monthly Deposit (FRS 2)
      };
      const { accType, code } = typeMap[data.entryType] ?? { accType: 'CD', code: 'L1004' };

      // Get next trans_no and ledgerid
      await lockLedgerIds(queryRunner); // ES-445
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      await assertPostingDateOpen(queryRunner, transDate); // ES-458

      // acc_no is always 0 — legacy never uses it for CD/MD/MD1
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, 0, $11, $12, $13)`,
        [
          nextTransNo, transDate, data.transType, code,
          data.memberNo, accType,
          data.amount, data.receiptVchrNo || '', data.vchrType || 'R',
          data.modeOfPay || 'C', data.narration || '', username, nextLedgerId
        ]
      );

      // BUG FIX: Double-entry bookkeeping — insert balancing cash/bank entry.
      // For CR (deposit): member deposit head is CR → cash/bank must be DR.
      // For DR (withdrawal): member deposit head is DR → cash/bank must be CR.
      const balancingTransType = data.transType === 'CR' ? 'DR' : 'CR';
      const isCash = !data.modeOfPay || data.modeOfPay.toUpperCase() === 'C';
      const cashCode    = isCash ? 'A1001' : 'A1008';  // A1001=Cash, A1008=Bank
      const cashAccType = isCash ? 'CINH'  : 'BANK';

      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, 0, $11, $12, $13)`,
        [
          nextTransNo + 1, transDate, balancingTransType, cashCode,
          data.memberNo, cashAccType,
          data.amount, data.receiptVchrNo || '', data.vchrType || 'R',
          data.modeOfPay || 'C', data.narration || '', username, nextLedgerId + 1
        ]
      );

      await queryRunner.commitTransaction();
      this.logger.log(`[FdRdSbEntry] Saved trans_no=${nextTransNo} acc_type=${accType} code=${code} cash_code=${cashCode} member=${data.memberNo}`);

      return { success: true, transNo: nextTransNo, message: `${data.entryType} entry saved (${accType}/${code}). Trans No: ${nextTransNo}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[FdRdSbEntry] Failed:`, error);
      throw new Error(`Failed to save entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async getFdRdSbAccounts(memberNo: number, entryType: 'FD' | 'RD' | 'SB'): Promise<any[]> {
    this.logger.log(`[FdRdSbEntry] Getting ${entryType} accounts for member ${memberNo}`);
    if (entryType === 'FD') {
      return this.dataSource.query(
        `SELECT account_number as "accountNo", certno as "certNo", fdamount as "amount", depdate as "depDate"
         FROM fdmaster WHERE mbno = $1 AND fdrdflag = 'F' ORDER BY account_number`,
        [memberNo]
      );
    } else if (entryType === 'RD') {
      return this.dataSource.query(
        `SELECT account_number as "accountNo", certno as "certNo", fdamount as "amount", depdate as "depDate"
         FROM fdmaster WHERE mbno = $1 AND fdrdflag = 'R' ORDER BY account_number`,
        [memberNo]
      );
    } else {
      // SB — derive from ledger
      const rows = await this.dataSource.query(
        `SELECT mbno as "accountNo", SUM(CASE WHEN trans_type='CR' THEN trans_amt::numeric ELSE -trans_amt::numeric END) as "balance"
         FROM ledger WHERE mbno = $1 AND acc_type = 'SB' GROUP BY mbno`,
        [memberNo]
      );
      return rows.map((r: any) => ({ accountNo: r.accountNo, certNo: 'SB', amount: r.balance }));
    }
  }

  async getDivisions(): Promise<any[]> {
    return this.dataSource.query(
      `SELECT wingno, officeno, divno, name, address, city FROM division_master ORDER BY name`
    );
  }

  async getHeadMaster(): Promise<any[]> {
    // ES-48: balances are computed live from the ledger (HEAD_BALANCES_SELECT), not read from the
    // balancesheet snapshot table, which nothing kept up to date.
    const result = await this.dataSource.query(`
      SELECT 
        hm.code, hm.parent_code as "parentCode", hm.head_name as "headName",
        hm.headtype as "headType", hm.interest, hm.hposition as "hposition",
        hm.pflag, hm.op_bal as "opBal",
        COALESCE(bs.opening_balance, 0) as "opening",
        COALESCE(bs.debit, 0) as "debit",
        COALESCE(bs.credit, 0) as "credit",
        COALESCE(bs.closingbalance, 0) as "balance"
      FROM headmaster hm
      LEFT JOIN (${HEAD_BALANCES_SELECT}) bs ON bs.head_code = hm.code
      ORDER BY hm.code
    `);
    return result;
  }

  /**
   * "Build Tree": persist the live head balances into the balancesheet table. The Head screen and
   * Balance Sheet no longer depend on it (they compute live); it is kept for anything that still reads
   * the stored table. Restored after commit 2cfd3e7 dropped it while the frontend kept calling it.
   */
  async rebuildBalancesheet(): Promise<{ success: boolean; message: string; leafCount: number }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      this.logger.log('[BuildTree] Rebuilding balancesheet from ledger...');
      await queryRunner.query(`DELETE FROM balancesheet`);
      // useStructuredResult exposes the inserted row count (.affected); a plain query() result is empty for INSERT.
      const result = await queryRunner.query(`
        INSERT INTO balancesheet
          (head_code, parent_code, head_name, opening_balance, debit, credit,
           closingbalance, closingbal_db, closing_cr, maincd)
        SELECT head_code, parent_code, head_name, opening_balance, debit, credit,
               closingbalance, closingbal_db, closing_cr, maincd
        FROM (${HEAD_BALANCES_SELECT}) live
      `, undefined, true);
      await queryRunner.commitTransaction();
      const leafCount = result.affected ?? 0;
      this.logger.log(`[BuildTree] Rebuilt ${leafCount} head balances from ledger`);
      return { success: true, message: `Balance sheet rebuilt from ledger. ${leafCount} accounts updated.`, leafCount };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('[BuildTree] Failed:', error);
      throw new Error(`Failed to rebuild balance sheet: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async saveHeadMaster(data: any): Promise<{ success: boolean; message: string }> {
    // Input checks (ES-358): headmaster.code is varchar(5), name varchar(100). Bad input is a 400, not a 500 from the INSERT,
    // and an empty code must never be stored.
    const text = (v: any) => (v === undefined || v === null ? '' : String(v).trim());
    data.code = text(data.code).toUpperCase(); // ES-636: 'l1005' and 'L1005' are the same head
    if (!/^[A-Za-z0-9]{1,5}$/.test(data.code)) {
      throw new BadRequestException('Head code must be 1 to 5 letters or digits.');
    }
    data.parentCode = text(data.parentCode).toUpperCase();
    data.pflag = text(data.pflag).toUpperCase();
    data.headType = text(data.headType).toUpperCase();
    data.interest = text(data.interest).toUpperCase();
    if (data.pflag && !['A', 'L', 'I', 'E', 'R'].includes(data.pflag)) {
      throw new BadRequestException('P Flag must be A (Asset), L (Liability), I (Income), E (Expenditure) or R (Root).');
    }
    if (data.interest && !['Y', 'N'].includes(data.interest)) {
      throw new BadRequestException('Interest must be Y or N.');
    }
    data.headName = text(data.headName);
    if (!data.headName || data.headName.length > 100) {
      throw new BadRequestException('Head name is required and can be at most 100 characters.');
    }
    if (data.opBal !== undefined && data.opBal !== null && data.opBal !== '' && !Number.isFinite(Number(data.opBal))) {
      throw new BadRequestException('Opening balance must be a number.');
    }
    for (const [field, max] of [['headType', 4], ['interest', 4], ['pflag', 4], ['hposition', 12]] as const) {
      if (data[field] !== undefined && data[field] !== null && String(data[field]).length > max) {
        throw new BadRequestException(`${field} can be at most ${max} characters.`);
      }
    }
    {
      const current = await this.dataSource.query(`SELECT parent_code, headtype FROM headmaster WHERE code = $1`, [data.code]);
      // ES-636: "Add" must never overwrite a head that already exists (it used to update it silently)
      if (data.isNew === true && current.length > 0) {
        throw new ConflictException(`Head ${data.code} already exists. Open it to change it.`);
      }
      const parent = text(data.parentCode);
      const parentChanged = current.length === 0 || text(current[0].parent_code) !== parent;
      if (parentChanged) {
        if (!parent || parent.length > 5) throw new BadRequestException('Parent head code is required (1 to 5 characters).');
        if (parent === data.code) throw new BadRequestException('A head cannot be its own parent.');
        const p = await this.dataSource.query(`SELECT 1 FROM headmaster WHERE code = $1`, [parent]);
        if (p.length === 0) throw new BadRequestException(`Parent head ${parent} does not exist.`);
        // the code letter is the section: L liabilities, A assets, I income, E expenditure (the window tells the user so)
        if (data.code[0] !== parent[0]) {
          throw new BadRequestException(`Head ${data.code} cannot sit under ${parent}: the code must start with ${parent[0]}, the section of its parent.`);
        }
        // a head can not be moved under its own child (that would make a loop and hide both from the tree)
        const loop = await this.dataSource.query(
          `WITH RECURSIVE up AS (
             SELECT code, parent_code, 1 AS d FROM headmaster WHERE code = $1
             UNION ALL
             SELECT h.code, h.parent_code, up.d + 1 FROM headmaster h JOIN up ON h.code = up.parent_code WHERE up.d < 50
           ) SELECT 1 FROM up WHERE code = $2 LIMIT 1`, [parent, data.code]);
        if (loop.length > 0) throw new BadRequestException(`${parent} is below ${data.code}, so ${data.code} cannot be placed under it.`);
      }
      data.parentCode = parent;
      // Head type tells the system what the head is for (CINH cash, BANK bank, RLN regular loan, SHR share ...). Legacy default is OTH.
      if (!data.headType) data.headType = current.length > 0 ? text(current[0].headtype) || 'OTH' : 'OTH';
      // the section flag follows the code letter when the caller sends none
      if (!data.pflag) data.pflag = ['A', 'L', 'I', 'E'].includes(data.code[0]) ? data.code[0] : 'L';
    }
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Check if code already exists
      const existing = await queryRunner.query(
        `SELECT code FROM headmaster WHERE code = $1`, [data.code]
      );

      if (existing && existing.length > 0) {
        // Update
        await queryRunner.query(
          `UPDATE headmaster SET parent_code = $1, head_name = $2, headtype = $3, 
           interest = $4, hposition = $5, pflag = $6, op_bal = $7
           WHERE code = $8`,
          [data.parentCode, data.headName, data.headType || null,
           data.interest || 'N', data.hposition || null, data.pflag || 'L',
           data.opBal || 0, data.code]
        );
      } else {
        // Insert
        await queryRunner.query(
          `INSERT INTO headmaster (code, parent_code, head_name, headtype, interest, hposition, pflag, op_bal)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [data.code, data.parentCode, data.headName, data.headType || null,
           data.interest || 'N', data.hposition || null, data.pflag || 'L',
           data.opBal || 0]
        );
      }

      await queryRunner.commitTransaction();
      return { success: true, message: `Head ${data.code} saved successfully.` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      // two people adding the same code at the same moment: the second one hits the unique key (ES-637)
      if ((error as any)?.code === '23505' || /duplicate key|unique constraint/i.test((error as any)?.message || '')) {
        throw new ConflictException(`Head ${data.code} already exists. Open it to change it.`);
      }
      throw new Error(`Failed to save head: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async getDepositLoanSlabs(type?: string): Promise<any[]> {    let query = `
      SELECT id, fdrd as "fdrd", scheme_code as "schemeCode",
             from_amount as "fromAmount", upto_amount as "uptoAmount",
             from_period as "fromPeriod", upto_period as "uptoPeriod",
             period_unit as "periodUnit", interest_rate as "interestRate",
             premature_interest_rate as "prematureInterestRate",
             applicable_from_date as "applicableFromDate",
             applicable_upto_date as "applicableUptoDate"
      FROM fdrd_slab_details
    `;
    const params: any[] = [];
    if (type) {
      query += ` WHERE fdrd = $1`;
      params.push(type.toUpperCase());
    }
    query += ` ORDER BY fdrd, from_amount, from_period`;
    return this.dataSource.query(query, params);
  }

  async saveDepositLoanSlabs(rows: any[], type: string): Promise<{ success: boolean; message: string }> {
    // ES-302: a missing or malformed body is a 400 with a reason, not a 500
    const slabType = typeof type === 'string' ? type.trim().toUpperCase() : '';
    if (!slabType || slabType.length > 30) {
      throw new BadRequestException('Slab type is required (for example RD or LOAN).');
    }
    if (!Array.isArray(rows)) throw new BadRequestException('rows must be a list of slab rows.');
    rows.forEach((row, i) => {
      if (row === null || typeof row !== 'object') throw new BadRequestException(`Row ${i + 1}: must be a slab entry.`);
      for (const f of ['fromAmount', 'uptoAmount', 'fromPeriod', 'uptoPeriod', 'interestRate', 'prematureInterestRate']) {
        const v = row[f];
        if (v === undefined || v === null || v === '') continue;
        if (!Number.isFinite(Number(v)) || Number(v) < 0) throw new BadRequestException(`Row ${i + 1}: ${f} must be a number, zero or more.`);
      }
      if (Number(row.interestRate) > 100 || Number(row.prematureInterestRate) > 100) throw new BadRequestException(`Row ${i + 1}: an interest rate cannot be more than 100.`);
      if (row.uptoAmount && Number(row.uptoAmount) < Number(row.fromAmount || 0)) throw new BadRequestException(`Row ${i + 1}: 'Upto amount' is less than 'From amount'.`);
      if (row.uptoPeriod && Number(row.uptoPeriod) < Number(row.fromPeriod || 0)) throw new BadRequestException(`Row ${i + 1}: 'Upto period' is less than 'From period'.`);
    });
    type = slabType;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Delete existing rows for this type and re-insert
      await queryRunner.query(`DELETE FROM fdrd_slab_details WHERE fdrd = $1`, [type.toUpperCase()]);

      for (const row of rows) {
        await queryRunner.query(
          `INSERT INTO fdrd_slab_details 
           (fdrd, scheme_code, from_amount, upto_amount, from_period, upto_period, 
            period_unit, interest_rate, premature_interest_rate, applicable_from_date, applicable_upto_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            type.toUpperCase(),
            row.schemeCode || null,
            row.fromAmount || 0,
            row.uptoAmount || 0,
            row.fromPeriod || 0,
            row.uptoPeriod || 0,
            row.periodUnit || 'M',
            row.interestRate || 0,
            row.prematureInterestRate || 0,
            row.applicableFromDate ? new Date(row.applicableFromDate) : null,
            row.applicableUptoDate ? new Date(row.applicableUptoDate) : null,
          ]
        );
      }

      await queryRunner.commitTransaction();
      return { success: true, message: `${type} slabs saved successfully.` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new Error(`Failed to save slabs: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async getDemandPrintOrder(): Promise<any[]> {    const result = await this.dataSource.query(
      `SELECT row_id, code as "headCode", headtype as "headType", interest as "inttType", 
              description, map_demand_columnname as "mapColName", printorder as "printOrder"
       FROM demandprintorder ORDER BY printorder`
    );
    return result;
  }

  async saveDemandPrintOrder(rows: any[]): Promise<{ success: boolean; message: string }> {
    // ES-302: a missing or malformed body is a 400 with a reason, not a 500
    if (!Array.isArray(rows)) throw new BadRequestException('rows must be a list of print-order rows.');
    rows.forEach((row, i) => {
      if (row === null || typeof row !== 'object') throw new BadRequestException(`Row ${i + 1}: must be a print-order entry.`);
      if (!String(row.headCode ?? '').trim()) throw new BadRequestException(`Row ${i + 1}: head code is required.`);
      if (!Number.isInteger(Number(row.printOrder)) || Number(row.printOrder) < 0) throw new BadRequestException(`Row ${i + 1}: print order must be a whole number, zero or more.`);
    });
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Delete all existing rows and re-insert (simple replace strategy)
      await queryRunner.query(`DELETE FROM demandprintorder`);

      for (const row of rows) {
        await queryRunner.query(
          `INSERT INTO demandprintorder (code, headtype, interest, description, map_demand_columnname, printorder)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.headCode, row.headType, row.inttType || 'N', row.description, row.mapColName, row.printOrder]
        );
      }

      await queryRunner.commitTransaction();
      return { success: true, message: 'Demand print order saved successfully.' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new Error(`Failed to save demand print order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async getBusinessRules(): Promise<Record<string, any>> {
    const result = await this.dataSource.query(
      `SELECT * FROM busrules ORDER BY appdate DESC LIMIT 1`
    );
    if (!result || result.length === 0) return {};
    const d = result[0];

    // Map real DB columns → frontend field names
    return {
      RULE_LOAN_R_MAX_AMT: d.rlnmaxloanamt,
      RULE_LOAN_R_RATE: d.rlnrate,
      RULE_LOAN_R_INSTALLMENTS: d.rlnmaxnoinst,
      RULE_LOAN_R_GUARANTORS: d.rlnnogr,
      RULE_LOAN_R_GRACE_DAYS: d.rlngracedays,
      RULE_LOAN_R_SM_PCT: d.rlnsmpct,
      RULE_LOAN_R_SM_DIV: d.rlnsmdiv,

      // BUG FIX: the frontend's "additionalLoan" card (aln* columns) sends/reads
      // RULE_LOAN_ADD_* — this used to return RULE_LOAN_LT_* instead, a stale key
      // name left over from before that card was renamed, so its max amount/rate/
      // installments/guarantors never actually round-tripped.
      RULE_LOAN_ADD_MAX_AMT: d.alnmaxloanamt,
      RULE_LOAN_ADD_RATE: d.alnrate,
      RULE_LOAN_ADD_INSTALLMENTS: d.alnmaxnoinst,
      RULE_LOAN_ADD_GUARANTORS: d.alnnogr,
      RULE_LOAN_ADD_PENAL_RATE: d.alnpenalrate,
      RULE_LOAN_ADD_GRACE_DAYS: d.alngracedays,
      RULE_LOAN_ADD_SM_PCT: d.alnsmpct,
      RULE_LOAN_ADD_SM_DIV: d.alnsmdiv,

      RULE_LOAN_MT_MAX_AMT: d.mlnmaxloanamt,
      RULE_LOAN_MT_RATE: d.mlnrate,
      RULE_LOAN_MT_INSTALLMENTS: d.mlnmaxnoinst,
      RULE_LOAN_MT_GUARANTORS: d.mlnnogr,

      RULE_LOAN_EMG_MAX_AMT: d.elnmaxloanamt,
      RULE_LOAN_EMG_RATE: d.elnrate,
      RULE_LOAN_EMG_INSTALLMENTS: d.elnmaxnoinst,
      RULE_LOAN_EMG_GUARANTORS: d.elnnogr,
      RULE_LOAN_EMG_PENAL_RATE: d.elnpenalrate,
      RULE_LOAN_EMG_GRACE_DAYS: d.elngracedays,
      RULE_LOAN_EMG_SM_PCT: d.elnsmpct,
      RULE_LOAN_EMG_SM_DIV: d.elnsmdiv,

      RULE_LOAN_DEP_MAX_AMT: d.edlmaxloanamt,
      RULE_LOAN_DEP_RATE: d.edlrate,
      RULE_LOAN_DEP_INSTALLMENTS: d.edlmaxnoinst,
      RULE_LOAN_DEP_GUARANTORS: d.edlnogr,

      RULE_LOAN_DEP_SHARE_VAL_PCT: d.loanagainstbasic,
      RULE_LOAN_DEP_FD_PCT: d.loanagainstdeppercent,
      RULE_LOAN_DEP_OVERALL_LIMIT: d.loanmaxlimit,
      RULE_LOAN_DEP_BASIC_PAY: d.loanagainstbasic,

      RULE_MEMBER_MIN_TENURE_MONTHS: d.minmembship,
      RULE_SHARE_MIN_AMT: d.minshareamt,
      RULE_SHARE_MAX_AMT: d.maxshareamt,
      // RULE_CD_MIN_AMT/RULE_CD_MAX_AMT deliberately removed — these legacy
      // busrules.mincdamt/maxcdamt columns were never read by any real
      // validation path anywhere in the app (confirmed by search), only
      // round-tripped through this admin screen. Since CD and RD are the
      // same product in this society, the real, ENFORCED minimum is
      // RULE_RD_MIN_MONTHLY_AMOUNT (system_configs, Modify Business Rules
      // -> RD System tab) — having a second, unenforced "CD min/max" here
      // just let the two silently drift apart with no way to notice, which
      // is exactly what had happened (mincdamt/maxcdamt sat at 200/200
      // while nothing ever checked a real CD amount against them). The
      // underlying busrules columns are left in place, only unused now.
      RULE_SECURITY_DEP_AMT: 0,
      RULE_PENAL_RATE: d.rlnpenalrate,

      SYS_DATA_ENTRY_MODE: d.dataentryflag === 'Y',
      SYS_PRINT_DEMAND_HORIZONTAL: d.print_demand_horizontal === 'Y',
      SYS_CONSIDER_INT_BEFORE_10TH: d.considerintt === 'Y',
      SYS_USE_REDUCING_BALANCE: d.reducingbal_intt_calc === 'Y' || Number(d.reducingbal_intt_calc) === 1,
      SYS_MIN_SAVINGS_BALANCE: d.minsavingbalance,
      SYS_SHOW_CONSOLIDATED_INT_IN_DEMAND: d.consolidateinttamountindemand === 'Y' || Number(d.consolidateinttamountindemand) === 1,
      SYS_GET_WORKING_CHARGES: false,
      SYS_WORKING_CHARGES_AMT: 0,
      SYS_AVG_INT_CALC_SLOT: d.intt_slot,
      SYS_PROFIT_HEAD: d.profit_head_code || '',

      ...await this.fetchSystemConfigRules(),
    };
  }

  private async fetchSystemConfigRules(): Promise<Record<string, any>> {
    const keys = [
      'RULE_FUND_INT_RATE', 'RULE_DIVIDEND_PCT', 'RULE_GRP_INSURANCE_AMT', 'RULE_CD_INTEREST_CHART',
      // Dividend rate rules: Fixed / Minimum / Maximum, each with an Active checkbox (ES-476)
      ...DIVIDEND_RATE_KEYS,
      // Nightly automatic Day-End switch — day-end.service.ts runs the job only when this is on.
      'SYS_DAYEND_AUTO_CLOSE',
      // RD/Share Value eligibility rule (loan-eligibility.service.ts) — these
      // used to be sent by the frontend's "Regular Loan Eligibility" section
      // and silently dropped on every save, since nothing here persisted them.
      'RULE_LOAN_R_MAX_LIMIT', 'RULE_LOAN_R_RD_PCT', 'RULE_LOAN_R_SHARE_PCT',
      'RULE_LOAN_R_SHORTFALL_MODE', 'RULE_LOAN_R_LIMIT_CALC',
      'RULE_LOAN_R_RD_HEAD_CODE', 'RULE_LOAN_R_SHARE_HEAD_CODE',
      // Per-loan-type on/off toggle for the same rule — default on for all three.
      'RULE_LOAN_ELIGIBILITY_APPLY_RLN', 'RULE_LOAN_ELIGIBILITY_APPLY_ALN', 'RULE_LOAN_ELIGIBILITY_APPLY_ELN',
      // Early Closure protection — "type the case number to confirm" before
      // the irreversible execute button enables. Two more protections
      // (password re-entry, minimum role) are deliberately deferred — this is
      // just the first, purely-frontend one.
      'RULE_EARLY_CLOSURE_REQUIRE_TYPE_CONFIRM',
      // How many months Slot 1 / Slot 2 (loan-rb-schedule.util.ts) delay both
      // the EMI's delay-interest sizing AND the installment due-date
      // schedule itself — see AddLoanMasterDelayMonths migration. Defaults
      // match the society's original hardcoded 1/2 months.
      'RULE_LOAN_SLOT1_DELAY_MONTHS', 'RULE_LOAN_SLOT2_DELAY_MONTHS',
      // Which application days fall in Slot 1 (inclusive, may wrap the month
      // boundary as the society's original 25th-5th window does). Slot 2 is
      // every other day by definition, so it is never stored separately and
      // the two slots can never overlap or leave a gap.
      'RULE_LOAN_SLOT1_START_DAY', 'RULE_LOAN_SLOT1_END_DAY',
      // How the constant monthly interest is rounded when an EMI is sized at
      // disbursement (NONE | NEAREST | UP | DOWN). NEAREST matches the
      // society's manual whole-rupee worksheets; applied once and frozen into
      // loan_master.instal_amt, never re-applied downstream.
      'RULE_LOAN_ROUNDING_MODE',
      // "Close to the old EMI" range in rupees for the check-this flags on consolidated loans
      // (loan-payment-flag.service.ts) — an amount within this of the old EMI, but not equal, is flagged.
      'RULE_LOAN_OLD_EMI_FLAG_TOLERANCE',
      // Loan re-agreement (restructure) limits. Every one defaults to permissive: the member already
      // holds the loan and the sanctioning authority decides, so these only add optional guard-rails.
      'RULE_REAGREEMENT_MIN_INSTALLMENTS_PAID', 'RULE_REAGREEMENT_MIN_OUTSTANDING', 'RULE_REAGREEMENT_MAX_TENURE',
      'RULE_REAGREEMENT_MIN_RATE', 'RULE_REAGREEMENT_MAX_RATE', 'RULE_REAGREEMENT_ALLOW_RATE_INCREASE',
      'RULE_REAGREEMENT_MAX_PER_LOAN', 'RULE_REAGREEMENT_ALLOW_BACKDATE',
      // ES-556: ON = an early closure waiting in Past Transaction is passed automatically when the awaited EMI is received.
      'RULE_EARLY_CLOSURE_AUTO_PASS',
      // ES-555: OFF (default) = no grace period in a loan closure; ON = the closure month's EMI keeps the grace-day behaviour.
      'RULE_LOAN_CLOSURE_GRACE_ENABLED', 'RULE_LOAN_NEXT_MONTH_ALLOW_NR',
      // One switch controls the tiered penal system for every active loan.
      // Activation date is maintained server-side so existing arrears are
      // never charged penalties for periods before the policy was enabled.
      'RULE_TIERED_LOAN_PENALTY_ENABLED', 'RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE',
      // ES-591: how strictly the Import Demand List treats a file with problems (STRICT | STANDARD).
      'RULE_DEMAND_IMPORT_STRICTNESS',
      // RD system (built from scratch — see rd-business-rules.ts). Defaults
      // here are placeholders pending the society's final policy numbers,
      // not authoritative thresholds.
      ...RD_RULE_KEYS,
    ];
    // "IS NOT FALSE", not "= true": the four Fund Management rows were seeded with isActive left
    // empty (NULL), so "= true" never loaded them — the screen showed 0 for the fund interest rate
    // while the real stored value is 7.0, and saving would have overwritten it with that 0.
    const rows = await this.dataSource.query(
      `SELECT key, value, "dataType" FROM system_configs WHERE key = ANY($1) AND "isActive" IS NOT FALSE`,
      [keys]
    );
    const out: Record<string, any> = {
      RULE_FUND_INT_RATE: 0,
      RULE_DIVIDEND_PCT: 0,
      RULE_DIVIDEND_FIXED_PCT: 0, RULE_DIVIDEND_FIXED_ACTIVE: false,
      RULE_DIVIDEND_MIN_PCT: 0, RULE_DIVIDEND_MIN_ACTIVE: false,
      RULE_DIVIDEND_MAX_PCT: 0, RULE_DIVIDEND_MAX_ACTIVE: false,
      RULE_GRP_INSURANCE_AMT: 0,
      RULE_CD_INTEREST_CHART: '[]',
      SYS_DAYEND_AUTO_CLOSE: false,
      RULE_LOAN_R_MAX_LIMIT: 1000000,
      RULE_LOAN_R_RD_PCT: 5,
      RULE_LOAN_R_SHARE_PCT: 5,
      RULE_LOAN_R_SHORTFALL_MODE: 'DEDUCT',
      RULE_LOAN_R_LIMIT_CALC: 'OUTSTANDING_PLUS_NEW',
      RULE_LOAN_R_RD_HEAD_CODE: 'L1004',
      RULE_LOAN_R_SHARE_HEAD_CODE: 'L1001',
      RULE_LOAN_ELIGIBILITY_APPLY_RLN: true,
      RULE_LOAN_ELIGIBILITY_APPLY_ALN: true,
      RULE_LOAN_ELIGIBILITY_APPLY_ELN: true,
      RULE_EARLY_CLOSURE_REQUIRE_TYPE_CONFIRM: true,
      RULE_LOAN_SLOT1_DELAY_MONTHS: 1,
      RULE_LOAN_SLOT2_DELAY_MONTHS: 2,
      RULE_LOAN_SLOT1_START_DAY: 25,
      RULE_LOAN_SLOT1_END_DAY: 5,
      RULE_LOAN_ROUNDING_MODE: 'NEAREST',
      RULE_LOAN_OLD_EMI_FLAG_TOLERANCE: 10,
      RULE_REAGREEMENT_MIN_INSTALLMENTS_PAID: 0,
      RULE_REAGREEMENT_MIN_OUTSTANDING: 0,
      RULE_REAGREEMENT_MAX_TENURE: 0,
      RULE_REAGREEMENT_MIN_RATE: 0,
      RULE_REAGREEMENT_MAX_RATE: 0,
      RULE_REAGREEMENT_ALLOW_RATE_INCREASE: true,
      RULE_REAGREEMENT_MAX_PER_LOAN: 0,
      RULE_REAGREEMENT_ALLOW_BACKDATE: false,
      RULE_EARLY_CLOSURE_AUTO_PASS: false,
      RULE_LOAN_CLOSURE_GRACE_ENABLED: false,
      RULE_LOAN_NEXT_MONTH_ALLOW_NR: true,
      RULE_TIERED_LOAN_PENALTY_ENABLED: false,
      RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE: '',
      // when the rule has never been saved the import is STRICT (DemandImportService.getStrictness does the same)
      RULE_DEMAND_IMPORT_STRICTNESS: 'STRICT',
      ...RD_RULE_DEFAULTS,
    };
    for (const row of rows) {
      if (row.dataType === 'number' || row.dataType === 'percentage') {
        out[row.key] = Number(row.value) || 0;
      } else if (row.dataType === 'json') {
        try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = []; }
      } else if (row.dataType === 'boolean') {
        out[row.key] = row.value === 'true' || row.value === '1' || row.value === 'Y';
      } else {
        out[row.key] = row.value ?? out[row.key];
      }
    }
    return out;
  }

  /** The interest chart arrives as a JSON string (or an array); always store valid JSON, never garbage. */
  private normaliseInterestChart(raw: unknown): string {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return JSON.stringify(Array.isArray(parsed) ? parsed : []);
    } catch {
      return '[]';
    }
  }

  /**
   * UPDATE-then-INSERT-if-absent for system_configs — used for keys that
   * belong there rather than in the legacy busrules table (currently just
   * the RD/Share eligibility rule and its per-loan-type on/off toggles).
   * There's no unique constraint on system_configs.key in the live database
   * (despite the entity declaring one — schema drift), so ON CONFLICT isn't
   * usable; this does the same thing in two steps instead.
   */
  private async upsertSystemConfigs(
    entries: Array<{ key: string; value: string; dataType: 'number' | 'string' | 'boolean' | 'percentage' | 'json' }>,
  ): Promise<void> {
    for (const entry of entries) {
      // BUG FIX: dataSource.query() returns [rows[], rowCount] for a non-SELECT
      // statement (even with RETURNING), not the rows array directly — same
      // gotcha already found and fixed in closeFixedDeposit() this session.
      // `updated.length` was therefore always 2 (never 0), so the INSERT
      // fallback below could never run: every save silently updated zero
      // rows and reported success regardless, for every key this function
      // has ever been asked to persist.
      const updated = await this.dataSource.query(
        `UPDATE system_configs SET value = $1, "dataType" = $2, "updatedAt" = NOW() WHERE key = $3 RETURNING id`,
        [entry.value, entry.dataType, entry.key],
      );
      if (updated[0].length === 0) {
        await this.dataSource.query(
          `INSERT INTO system_configs (key, name, value, "dataType", category, "isActive", "isReadonly", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, 'business_rules', true, false, NOW(), NOW())`,
          [entry.key, entry.key.replace(/_/g, ' ').toLowerCase(), entry.value, entry.dataType],
        );
      }
    }
  }

  /** ES-482: the loan limits that must always be sent. A missing key used to be saved as 0 and wiped the live rules. */
  private static readonly REQUIRED_LOAN_RULE_KEYS = [
    'RULE_LOAN_R_MAX_AMT', 'RULE_LOAN_R_RATE', 'RULE_LOAN_R_INSTALLMENTS', 'RULE_PENAL_RATE', 'RULE_LOAN_R_GRACE_DAYS',
    'RULE_LOAN_ADD_MAX_AMT', 'RULE_LOAN_ADD_RATE', 'RULE_LOAN_ADD_INSTALLMENTS', 'RULE_LOAN_ADD_PENAL_RATE', 'RULE_LOAN_ADD_GRACE_DAYS',
    'RULE_LOAN_EMG_MAX_AMT', 'RULE_LOAN_EMG_RATE', 'RULE_LOAN_EMG_INSTALLMENTS', 'RULE_LOAN_EMG_PENAL_RATE', 'RULE_LOAN_EMG_GRACE_DAYS',
  ];

  private assertLoanRulesComplete(data: Record<string, any>): void {
    const missing: string[] = [];
    const invalid: string[] = [];
    for (const k of UtilitiesService.REQUIRED_LOAN_RULE_KEYS) {
      const v = data?.[k];
      if (v === undefined || v === null || v === '') { missing.push(k); continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) invalid.push(k);
    }
    if (missing.length || invalid.length) {
      const parts: string[] = [];
      if (missing.length) parts.push('missing: ' + missing.join(', '));
      if (invalid.length) parts.push('must be a number, zero or more: ' + invalid.join(', '));
      throw new BadRequestException('Business rules were not saved. Loan limits are required (' + parts.join('; ') + ').');
    }
  }

  async updateBusinessRules(data: Record<string, any>): Promise<{ success: boolean; message: string }> {
    this.assertLoanRulesComplete(data); // ES-482: a partial or empty body must not overwrite the live rules with zeros
    // ES-476: refuse a dividend rate rule that contradicts itself before anything is saved
    const sentDividendRules = DIVIDEND_RATE_KEYS.some((k) => data[k] !== undefined);
    if (sentDividendRules) validateDividendRateRuleSettings(dividendRateRulesFrom(data));
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Insert a new busrules row with updated values (legacy pattern — each save creates new row)
      await queryRunner.query(
        `INSERT INTO busrules (
          appdate,
          rlnmaxloanamt, rlnrate, rlnpenalrate, rlnmaxnoinst, rlnnogr,
          elnmaxloanamt, elnrate, elnmaxnoinst, elnnogr,
          alnmaxloanamt, alnrate, alnmaxnoinst, alnnogr,
          mlnmaxloanamt, mlnrate, mlnmaxnoinst, mlnnogr,
          edlmaxloanamt, edlrate, edlmaxnoinst, edlnogr,
          minmembship, minshareamt, maxshareamt, mincdamt, maxcdamt,
          loanmaxlimit, loanagainstbasic, loanagainstdeppercent,
          dataentryflag, print_demand_horizontal, reducingbal_intt_calc,
          minsavingbalance, consolidateinttamountindemand, considerintt,
          intt_slot, profit_head_code, defaultduration,
          alnpenalrate, elnpenalrate,
          rlngracedays, rlnsmpct, rlnsmdiv,
          alngracedays, alnsmpct, alnsmdiv,
          elngracedays, elnsmpct, elnsmdiv
        ) VALUES (
          NOW(),
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24, $25, $26,
          $27, $28, $29,
          $30, $31, $32,
          $33, $34, $35,
          $36, $37, $38,
          $39, $40,
          $41, $42, $43,
          $44, $45, $46,
          $47, $48, $49
        )`,
        [
          data.RULE_LOAN_R_MAX_AMT || 0, data.RULE_LOAN_R_RATE || 0, data.RULE_PENAL_RATE || 0, data.RULE_LOAN_R_INSTALLMENTS || 0, data.RULE_LOAN_R_GUARANTORS || 0,
          data.RULE_LOAN_EMG_MAX_AMT || 0, data.RULE_LOAN_EMG_RATE || 0, data.RULE_LOAN_EMG_INSTALLMENTS || 0, data.RULE_LOAN_EMG_GUARANTORS || 0,
          // BUG FIX: was reading data.RULE_LOAN_LT_* — a stale key name the
          // frontend's "additionalLoan" card stopped sending after it was
          // renamed (it now sends RULE_LOAN_ADD_*), so these 4 fields were
          // silently always saved as 0.
          data.RULE_LOAN_ADD_MAX_AMT || 0, data.RULE_LOAN_ADD_RATE || 0, data.RULE_LOAN_ADD_INSTALLMENTS || 0, data.RULE_LOAN_ADD_GUARANTORS || 0,
          data.RULE_LOAN_MT_MAX_AMT || 0, data.RULE_LOAN_MT_RATE || 0, data.RULE_LOAN_MT_INSTALLMENTS || 0, data.RULE_LOAN_MT_GUARANTORS || 0,
          data.RULE_LOAN_DEP_MAX_AMT || 0, data.RULE_LOAN_DEP_RATE || 0, data.RULE_LOAN_DEP_INSTALLMENTS || 0, data.RULE_LOAN_DEP_GUARANTORS || 0,
          // mincdamt/maxcdamt: no longer a configurable field (see the
          // removal note on getBusinessRules() above) — column kept NOT
          // NULL-safe with a plain 0, never read from the request payload.
          data.RULE_MEMBER_MIN_TENURE_MONTHS || 0, data.RULE_SHARE_MIN_AMT || 0, data.RULE_SHARE_MAX_AMT || 0, 0, 0,
          data.RULE_LOAN_DEP_OVERALL_LIMIT || 0, data.RULE_LOAN_DEP_SHARE_VAL_PCT || 0, data.RULE_LOAN_DEP_FD_PCT || 0,
          data.SYS_DATA_ENTRY_MODE ? 'Y' : 'N',
          data.SYS_PRINT_DEMAND_HORIZONTAL ? 'Y' : 'N',
          data.SYS_USE_REDUCING_BALANCE ? 1 : 0,
          data.SYS_MIN_SAVINGS_BALANCE || 0,
          data.SYS_SHOW_CONSOLIDATED_INT_IN_DEMAND ? 1 : 0,
          data.SYS_CONSIDER_INT_BEFORE_10TH ? 'Y' : 'N',
          data.SYS_AVG_INT_CALC_SLOT || 0,
          data.SYS_PROFIT_HEAD || null,
          0, // defaultduration — NOT NULL, default 0
          // Grace/same-month-penal fields — previously not persisted at all,
          // so the "Modify Business Rules" screen's grace/penal inputs never
          // actually reached the database.
          data.RULE_LOAN_ADD_PENAL_RATE || 0, data.RULE_LOAN_EMG_PENAL_RATE || 0,
          data.RULE_LOAN_R_GRACE_DAYS || 0, data.RULE_LOAN_R_SM_PCT || 0, data.RULE_LOAN_R_SM_DIV || 0,
          data.RULE_LOAN_ADD_GRACE_DAYS || 0, data.RULE_LOAN_ADD_SM_PCT || 0, data.RULE_LOAN_ADD_SM_DIV || 0,
          data.RULE_LOAN_EMG_GRACE_DAYS || 0, data.RULE_LOAN_EMG_SM_PCT || 0, data.RULE_LOAN_EMG_SM_DIV || 0,
        ]
      );

      await queryRunner.commitTransaction();

      const oldPenaltyRows = await this.dataSource.query(
        `SELECT value FROM system_configs WHERE key = 'RULE_TIERED_LOAN_PENALTY_ENABLED' AND "isActive" = true LIMIT 1`,
      );
      const wasPenaltyEnabled = ['true', '1', 'y'].includes(String(oldPenaltyRows[0]?.value ?? '').toLowerCase());
      const willPenaltyBeEnabled = data.RULE_TIERED_LOAN_PENALTY_ENABLED === true
        || ['true', '1', 'y'].includes(String(data.RULE_TIERED_LOAN_PENALTY_ENABLED ?? '').toLowerCase());
      const penaltyActivationRows = await this.dataSource.query(
        `SELECT value FROM system_configs WHERE key = 'RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE' AND "isActive" = true LIMIT 1`,
      );
      const savedActivationDate = penaltyActivationRows[0]?.value;
      const penaltyActivationDate = willPenaltyBeEnabled && (!wasPenaltyEnabled || !savedActivationDate)
        ? (await this.dataSource.query(`SELECT CURRENT_DATE::text AS today`))[0].today
        : (savedActivationDate || (await this.dataSource.query(`SELECT CURRENT_DATE::text AS today`))[0].today);

      // RD/Share Value eligibility rule + per-loan-type on/off toggles —
      // these belong in system_configs (where loan-eligibility.service.ts
      // actually reads them from), not busrules, so they're persisted
      // separately from the INSERT above.
      await this.upsertSystemConfigs([
        { key: 'RULE_LOAN_R_MAX_LIMIT', value: String(data.RULE_LOAN_R_MAX_LIMIT ?? 1000000), dataType: 'number' },
        { key: 'RULE_LOAN_R_RD_PCT', value: String(data.RULE_LOAN_R_RD_PCT ?? 5), dataType: 'number' },
        { key: 'RULE_LOAN_R_SHARE_PCT', value: String(data.RULE_LOAN_R_SHARE_PCT ?? 5), dataType: 'number' },
        { key: 'RULE_LOAN_R_SHORTFALL_MODE', value: String(data.RULE_LOAN_R_SHORTFALL_MODE ?? 'DEDUCT'), dataType: 'string' },
        { key: 'RULE_LOAN_R_LIMIT_CALC', value: String(data.RULE_LOAN_R_LIMIT_CALC ?? 'OUTSTANDING_PLUS_NEW'), dataType: 'string' },
        { key: 'RULE_LOAN_R_RD_HEAD_CODE', value: String(data.RULE_LOAN_R_RD_HEAD_CODE ?? 'L1004'), dataType: 'string' },
        { key: 'RULE_LOAN_R_SHARE_HEAD_CODE', value: String(data.RULE_LOAN_R_SHARE_HEAD_CODE ?? 'L1001'), dataType: 'string' },
        { key: 'RULE_LOAN_ELIGIBILITY_APPLY_RLN', value: data.RULE_LOAN_ELIGIBILITY_APPLY_RLN === false ? 'false' : 'true', dataType: 'boolean' },
        { key: 'RULE_LOAN_ELIGIBILITY_APPLY_ALN', value: data.RULE_LOAN_ELIGIBILITY_APPLY_ALN === false ? 'false' : 'true', dataType: 'boolean' },
        // Loan Against RD's limit check is always on (it is what the RD lock secures), so this switch is
        // not honoured: always stored as 'true' so a stale 'false' can never mislead anyone.
        { key: 'RULE_LOAN_ELIGIBILITY_APPLY_ELN', value: 'true', dataType: 'boolean' },
        { key: 'RULE_EARLY_CLOSURE_REQUIRE_TYPE_CONFIRM', value: data.RULE_EARLY_CLOSURE_REQUIRE_TYPE_CONFIRM === false ? 'false' : 'true', dataType: 'boolean' },
        { key: 'RULE_TIERED_LOAN_PENALTY_ENABLED', value: willPenaltyBeEnabled ? 'true' : 'false', dataType: 'boolean' },
        { key: 'RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE', value: penaltyActivationDate, dataType: 'string' },
        { key: 'RULE_LOAN_SLOT1_DELAY_MONTHS', value: String(data.RULE_LOAN_SLOT1_DELAY_MONTHS ?? 1), dataType: 'number' },
        { key: 'RULE_LOAN_SLOT2_DELAY_MONTHS', value: String(data.RULE_LOAN_SLOT2_DELAY_MONTHS ?? 2), dataType: 'number' },
        // Clamped to a real day-of-month (1-31) on the way in — an out-of-range
        // or non-numeric window would otherwise classify every application into
        // Slot 2 and silently misprice every loan disbursed afterwards.
        { key: 'RULE_LOAN_SLOT1_START_DAY', value: String(clampDayOfMonth(data.RULE_LOAN_SLOT1_START_DAY, 25)), dataType: 'number' },
        { key: 'RULE_LOAN_SLOT1_END_DAY', value: String(clampDayOfMonth(data.RULE_LOAN_SLOT1_END_DAY, 5)), dataType: 'number' },
        { key: 'RULE_LOAN_ROUNDING_MODE', value: ['NONE', 'NEAREST', 'UP', 'DOWN'].includes(data.RULE_LOAN_ROUNDING_MODE) ? data.RULE_LOAN_ROUNDING_MODE : 'NEAREST', dataType: 'string' },
        { key: 'RULE_LOAN_OLD_EMI_FLAG_TOLERANCE', value: String(Math.min(100000, Math.max(0, Number(data.RULE_LOAN_OLD_EMI_FLAG_TOLERANCE ?? 10) || 0))), dataType: 'number' },
        // Loan re-agreement limits (0 = no limit).
        ...['RULE_REAGREEMENT_MIN_INSTALLMENTS_PAID', 'RULE_REAGREEMENT_MIN_OUTSTANDING', 'RULE_REAGREEMENT_MAX_TENURE',
          'RULE_REAGREEMENT_MIN_RATE', 'RULE_REAGREEMENT_MAX_RATE', 'RULE_REAGREEMENT_MAX_PER_LOAN'].map((key) => ({
          key, value: String(Math.max(0, Number(data[key] ?? 0) || 0)), dataType: 'number' as const,
        })),
        { key: 'RULE_REAGREEMENT_ALLOW_RATE_INCREASE', value: data.RULE_REAGREEMENT_ALLOW_RATE_INCREASE === false ? 'false' : 'true', dataType: 'boolean' },
        { key: 'RULE_REAGREEMENT_ALLOW_BACKDATE', value: data.RULE_REAGREEMENT_ALLOW_BACKDATE === true ? 'true' : 'false', dataType: 'boolean' },
        { key: 'RULE_EARLY_CLOSURE_AUTO_PASS', value: data.RULE_EARLY_CLOSURE_AUTO_PASS === true ? 'true' : 'false', dataType: 'boolean' },
        { key: 'RULE_LOAN_NEXT_MONTH_ALLOW_NR', value: data.RULE_LOAN_NEXT_MONTH_ALLOW_NR === false ? 'false' : 'true', dataType: 'boolean' },
        { key: 'RULE_LOAN_CLOSURE_GRACE_ENABLED', value: data.RULE_LOAN_CLOSURE_GRACE_ENABLED === true ? 'true' : 'false', dataType: 'boolean' },
        // Auto Day-End switch: the nightly job (day-end.service.ts) runs only when this is ON.
        { key: 'SYS_DAYEND_AUTO_CLOSE', value: data.SYS_DAYEND_AUTO_CLOSE === true ? 'true' : 'false', dataType: 'boolean' },
        // ES-591: Import Demand strictness. Written only when the screen sent it (an older client must not reset it);
        // anything other than STANDARD is stored as STRICT, so a bad value can never loosen the import.
        ...(data.RULE_DEMAND_IMPORT_STRICTNESS !== undefined
          ? [{ key: 'RULE_DEMAND_IMPORT_STRICTNESS', value: String(data.RULE_DEMAND_IMPORT_STRICTNESS).trim().toUpperCase() === 'STANDARD' ? 'STANDARD' : 'STRICT', dataType: 'string' as const }]
          : []),
        // Fund Management — read by the interest run, profit distribution and the dashboard, but this
        // screen never saved them. Written only when the screen actually sent the value, so an older
        // client that omits them can't zero them.
        ...(data.RULE_FUND_INT_RATE !== undefined ? [{ key: 'RULE_FUND_INT_RATE', value: String(Math.max(0, Number(data.RULE_FUND_INT_RATE) || 0)), dataType: 'percentage' as const }] : []),
        ...(data.RULE_DIVIDEND_PCT !== undefined ? [{ key: 'RULE_DIVIDEND_PCT', value: String(Math.max(0, Number(data.RULE_DIVIDEND_PCT) || 0)), dataType: 'percentage' as const }] : []),
        ...(sentDividendRules ? [
          { key: 'RULE_DIVIDEND_FIXED_PCT', value: String(Number(data.RULE_DIVIDEND_FIXED_PCT) || 0), dataType: 'percentage' as const },
          { key: 'RULE_DIVIDEND_FIXED_ACTIVE', value: data.RULE_DIVIDEND_FIXED_ACTIVE === true ? 'true' : 'false', dataType: 'boolean' as const },
          { key: 'RULE_DIVIDEND_MIN_PCT', value: String(Number(data.RULE_DIVIDEND_MIN_PCT) || 0), dataType: 'percentage' as const },
          { key: 'RULE_DIVIDEND_MIN_ACTIVE', value: data.RULE_DIVIDEND_MIN_ACTIVE === true ? 'true' : 'false', dataType: 'boolean' as const },
          { key: 'RULE_DIVIDEND_MAX_PCT', value: String(Number(data.RULE_DIVIDEND_MAX_PCT) || 0), dataType: 'percentage' as const },
          { key: 'RULE_DIVIDEND_MAX_ACTIVE', value: data.RULE_DIVIDEND_MAX_ACTIVE === true ? 'true' : 'false', dataType: 'boolean' as const },
        ] : []),
        ...(data.RULE_GRP_INSURANCE_AMT !== undefined ? [{ key: 'RULE_GRP_INSURANCE_AMT', value: String(Math.max(0, Number(data.RULE_GRP_INSURANCE_AMT) || 0)), dataType: 'number' as const }] : []),
        ...(data.RULE_CD_INTEREST_CHART !== undefined ? [{ key: 'RULE_CD_INTEREST_CHART', value: this.normaliseInterestChart(data.RULE_CD_INTEREST_CHART), dataType: 'json' as const }] : []),
        // RD system rules — new dedicated tab in Modify Business Rules.
        ...RD_RULE_KEYS.map((key) => ({
          key,
          value: RD_BOOLEAN_RULE_KEYS.includes(key)
            ? (data[key] === false ? 'false' : 'true')
            : String(data[key] ?? RD_RULE_DEFAULTS[key]),
          dataType: (RD_BOOLEAN_RULE_KEYS.includes(key) ? 'boolean' : 'number') as 'boolean' | 'number',
        })),
      ]);

      return { success: true, message: 'Business rules saved successfully.' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof HttpException) throw error;
      throw new Error(`Failed to save business rules: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  // ─── Financial Year ───────────────────────────────────────────────────────

  async getCurrentFinancialYear(): Promise<{ yearcode: number; startDate: Date; endDate: Date }> {
    const result = await this.dataSource.query(
      `SELECT yearcode, start_date, end_date 
       FROM yearend 
       WHERE start_date IS NOT NULL AND end_date IS NOT NULL
       ORDER BY yearcode DESC LIMIT 1`,
    );
    if (!result || result.length === 0) {
      throw new Error('No financial year found in the system.');
    }
    const row = result[0];
    return {
      yearcode: row.yearcode,
      startDate: row.start_date,
      endDate: row.end_date,
    };
  }

  async transferEntriesForClosing(
    yearCode: number,
    username: string = 'system',
  ): Promise<{ success: boolean; yearcode: number; rowsTransferred: number; message: string }> {
    // Validate yearcode exists
    const yearCheck = await this.dataSource.query(
      `SELECT yearcode FROM yearend WHERE yearcode = $1`,
      [yearCode],
    );
    if (!yearCheck || yearCheck.length === 0) {
      throw new Error(
        `Financial Year Code ${yearCode} not found. Please verify the code and try again.`,
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Remove existing bankopbal entries for this fycode (idempotent re-run)
      await queryRunner.query(
        `DELETE FROM bankopbal WHERE fycode = $1`,
        [yearCode],
      );

      // Insert closing balances from balancesheet into bankopbal
      // This matches legacy behavior: Transfer Entries writes to bankopbal, not yearend_head
      await queryRunner.query(
        `INSERT INTO bankopbal (fycode, headcode, parentcode, closingbalance)
         SELECT $1, head_code, parent_code, closingbalance
         FROM (${HEAD_BALANCES_SELECT}) live
         WHERE COALESCE(closingbalance, 0) <> 0`,
        [yearCode],
      );

      // Count how many rows were inserted
      const countResult = await queryRunner.query(
        `SELECT COUNT(*) as cnt FROM bankopbal WHERE fycode = $1`,
        [yearCode],
      );
      const rowsTransferred = parseInt(countResult[0]?.cnt ?? '0', 10);

      // Track who ran this on the yearend record
      await queryRunner.query(
        `UPDATE yearend SET username = $1 WHERE yearcode = $2`,
        [username, yearCode],
      );

      await queryRunner.commitTransaction();

      return {
        success: true,
        yearcode: yearCode,
        rowsTransferred,
        message: `Transfer entries for Financial Year ${yearCode} completed. ${rowsTransferred} head balances transferred.`,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new Error(
        `Failed to transfer entries: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      await queryRunner.release();
    }
  }

  // ── ES-54: methods removed by commit 2cfd3e7 but still called by the app; restored from 2cfd3e7^ ──

  // Premature Information (RD/SB) lists the actual account holders so the screen can offer a
  // scoped dropdown instead of a blind member-number search.
  async listRdAccountHolders(): Promise<any[]> {
    const query = `
      SELECT
        f.mbno as "memberNo",
        REGEXP_REPLACE(TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')), '\\s+', ' ', 'g') as "memberName",
        f.account_number as "accountNumber",
        f.fdamount as "monthlyInstallment"
      FROM fdmaster f
      LEFT JOIN member_master m ON f.mbno::text = m.mbno::text
      WHERE f.fdrdflag = 'R' AND f.status = '0'
      ORDER BY f.mbno
    `;
    return this.dataSource.query(query);
  }

  async listSbAccountHolders(): Promise<any[]> {
    // sbmaster is the real, authoritative SB account table.
    const query = `
      SELECT
        s.mbno as "memberNo",
        REGEXP_REPLACE(TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')), '\\s+', ' ', 'g') as "memberName",
        s.acc_no as "accountNumber",
        s.balance
      FROM sbmaster s
      LEFT JOIN member_master m ON s.mbno::text = m.mbno::text
      ORDER BY s.mbno
    `;
    return this.dataSource.query(query);
  }

  /**
   * Running ledger balance for an account head (asset convention: DR increases,
   * CR decreases) — used to show the live Bank/Cash balance on voucher screens.
   */
  async getHeadBalance(code: string): Promise<number> {
    const res = await this.dataSource.query(
      `SELECT COALESCE(SUM(CASE WHEN trans_type = 'DR' THEN trans_amt::numeric ELSE -trans_amt::numeric END), 0) AS balance
       FROM ledger WHERE code = $1`,
      [code],
    );
    return Number(res[0]?.balance || 0);
  }

  async deleteHeadMaster(code: string): Promise<{ success: boolean; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const exists = await queryRunner.query(`SELECT 1 FROM headmaster WHERE code = $1`, [code]);
      if (exists.length === 0) {
        throw new NotFoundException(`Head ${code} not found.`);
      }
      const children = await queryRunner.query(
        `SELECT COUNT(*)::int AS cnt FROM headmaster WHERE parent_code = $1`, [code]
      );
      if (children[0].cnt > 0) {
        throw new ConflictException(`${code} has ${children[0].cnt} child heads — remove children first.`);
      }
      // Deleting a head with real ledger postings would silently drop those transactions from
      // every future rebuildBalancesheet() run (it LEFT JOINs from headmaster) instead of erroring.
      const postings = await queryRunner.query(
        `SELECT COUNT(*)::int AS cnt FROM ledger WHERE code = $1`, [code]
      );
      if (postings[0].cnt > 0) {
        throw new ConflictException(`${code} has ${postings[0].cnt} ledger transaction(s) posted against it — cannot delete.`);
      }
      // ES-636: vouchers still waiting to be passed also point at the head, and system heads (cash, loans, share, CD, MD)
      // are looked up by their type all over the app, so they cannot be removed from here
      const staged = await queryRunner.query(`SELECT COUNT(*)::int AS cnt FROM transactions WHERE TRIM(code) = $1`, [code]);
      if (staged[0].cnt > 0) {
        throw new ConflictException(`${code} is used by ${staged[0].cnt} voucher line(s) — cannot delete.`);
      }
      const kind = await queryRunner.query(`SELECT headtype, pflag FROM headmaster WHERE code = $1`, [code]);
      if (kind[0]?.pflag === 'R') throw new ConflictException(`${code} is a section head and cannot be deleted.`);
      if (['CINH', 'RLN', 'ALN', 'SHR', 'CD', 'MD', 'MD1'].includes(String(kind[0]?.headtype || '').trim())) {
        throw new ConflictException(`${code} is a system head (${String(kind[0].headtype).trim()}) that the application uses, so it cannot be deleted.`);
      }
      await queryRunner.query(`DELETE FROM headmaster   WHERE code      = $1`, [code]);
      await queryRunner.query(`DELETE FROM balancesheet WHERE head_code = $1`, [code]);
      await queryRunner.commitTransaction();
      this.logger.log(`[DeleteHead] Deleted head ${code}`);
      return { success: true, message: `${code} deleted successfully.` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof HttpException) throw error;
      throw new Error(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      await queryRunner.release();
    }
  }

  async getFinancialYears(): Promise<any[]> {
    // yearcode is just a sequential ID (1, 2, 3…), not a calendar year: the real dates live on
    // the row itself (start_date/end_date), set at creation by FinancialYearService.
    const rows = await this.dataSource.query(
      `SELECT DISTINCT ON (yearcode) yearcode, start_date, end_date, (closed_at IS NOT NULL) AS closed
       FROM yearend WHERE yearcode IS NOT NULL ORDER BY yearcode`
    );
    const fmt = (d: Date) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    return rows.map((r: any) => {
      const startDate = fmt(r.start_date);
      const endDate = fmt(r.end_date);
      return { yearcode: parseInt(r.yearcode), startDate, endDate, label: `${startDate} - ${endDate}`, closed: !!r.closed };
    });
  }

  /** The financial year row, or a 400 / 404. A closed year is returned flagged so callers can refuse to change it. */
  private async openingYear(runner: { query: (s: string, p?: any[]) => Promise<any> }, yearcode: any): Promise<{ yearcode: number; closed: boolean }> {
    const n = Number(yearcode);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('Choose a financial year.');
    const y = await runner.query(`SELECT yearcode, (closed_at IS NOT NULL) AS closed FROM yearend WHERE yearcode = $1 LIMIT 1`, [n]);
    if (!y || y.length === 0) throw new NotFoundException(`Financial year ${n} does not exist.`);
    return { yearcode: n, closed: !!y[0].closed };
  }

  async getHeadOpeningBalances(yearcode: number): Promise<any[]> {
    await this.openingYear(this.dataSource, yearcode); // ES-640: unknown / missing year is a clear 4xx, not an empty list
    return this.dataSource.query(`
      SELECT
        hm.code,
        hm.parent_code  AS "parentCode",
        hm.head_name    AS "headName",
        hm.headtype     AS "headType",
        COALESCE(yh.closing_bal, hm.op_bal, 0) AS "openingBal",
        (yh.head_code IS NOT NULL) AS "hasYearData"
      FROM headmaster hm
      LEFT JOIN (
        SELECT DISTINCT ON (head_code) head_code, closing_bal
        FROM yearend_head
        WHERE yearcode = $1
        ORDER BY head_code
      ) yh ON yh.head_code = hm.code
      ORDER BY hm.code
    `, [yearcode]);
  }

  async saveHeadOpeningBalances(
    yearcode: number,
    balances: Array<{ headCode: string; closingBal: number }>,
  ): Promise<{ success: boolean; message: string }> {
    // ES-640: input checks first (400), before anything is touched. An empty list would wipe the year, so it is refused.
    if (!Array.isArray(balances) || balances.length === 0) throw new BadRequestException('Send at least one head balance.');
    if (balances.length > 2000) throw new BadRequestException('Too many head balances in one save (the most is 2000).');
    const seen = new Set<string>();
    const codes: string[] = [];
    const amounts: number[] = [];
    for (const b of balances) {
      const code = String(b?.headCode ?? '').trim().toUpperCase();
      if (!code || code.length > 5) throw new BadRequestException('Every balance needs a head code of 1 to 5 characters.');
      if (seen.has(code)) throw new BadRequestException(`Head ${code} is listed twice.`);
      seen.add(code);
      const raw: any = b?.closingBal;
      const amt = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
      if (!Number.isFinite(amt)) throw new BadRequestException(`The balance of ${code} must be a number.`);
      if (Math.abs(amt) >= 1e13) throw new BadRequestException(`The balance of ${code} is too large.`);
      codes.push(code);
      amounts.push(Math.round(amt * 100) / 100);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const year = await this.openingYear(queryRunner, yearcode);
      // two people saving the same year at once would interleave delete + insert; take one lock per year
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`yearend_head:${year.yearcode}`]);
      if (year.closed) throw new ConflictException(`Financial year ${year.yearcode} is closed, so its opening balances cannot be changed.`);

      const known = await queryRunner.query(`SELECT code FROM headmaster WHERE code = ANY($1::text[])`, [codes]);
      const knownSet = new Set<string>(known.map((r: any) => String(r.code).trim()));
      const unknown = codes.filter(c => !knownSet.has(c));
      if (unknown.length > 0) {
        throw new BadRequestException(`Unknown head code${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ' ...' : ''}.`);
      }

      await queryRunner.query(
        `DELETE FROM yearend_head WHERE yearcode = $1 AND head_code IN (SELECT code FROM headmaster)`,
        [year.yearcode],
      );
      await queryRunner.query(
        `INSERT INTO yearend_head (yearcode, head_code, parent_code, closing_bal)
         SELECT $1, hm.code, hm.parent_code, v.amt
           FROM unnest($2::text[], $3::numeric[]) AS v(code, amt)
           JOIN headmaster hm ON hm.code = v.code`,
        [year.yearcode, codes, amounts],
      );
      await queryRunner.commitTransaction();
      this.logger.log(`[HeadOpenBal] Saved ${codes.length} balances for year ${year.yearcode}`);
      return { success: true, message: `Saved ${codes.length} head balances for year ${year.yearcode}.` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof HttpException) throw error;
      throw new Error(`Failed to save opening balances: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async applyYearOpeningBalances(yearcode: number): Promise<{ success: boolean; message: string; updated: number }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const year = await this.openingYear(queryRunner, yearcode);
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`yearend_head:${year.yearcode}`]);
      // ES-640: a closed year's balances must not overwrite the live opening balances, and a year with nothing
      // saved must not report "applied" (it used to answer success with 0 accounts updated)
      if (year.closed) throw new ConflictException(`Financial year ${year.yearcode} is closed, so its balances cannot be applied.`);
      const saved = await queryRunner.query(`SELECT COUNT(*)::int AS n FROM yearend_head WHERE yearcode = $1`, [year.yearcode]);
      if (!saved[0] || saved[0].n === 0) throw new BadRequestException(`No opening balances are saved for financial year ${year.yearcode}. Save them first.`);
      // queryRunner.query() only returns raw.rows by default, which is empty for an UPDATE with no
      // RETURNING clause; pass useStructuredResult:true to read the affected row count instead.
      const result = await queryRunner.query(`
        UPDATE headmaster hm
        SET op_bal = yh.closing_bal
        FROM (
          SELECT DISTINCT ON (head_code) head_code, closing_bal
          FROM yearend_head
          WHERE yearcode = $1 AND head_code IN (SELECT code FROM headmaster)
          ORDER BY head_code
        ) yh
        WHERE hm.code = yh.head_code
      `, [yearcode], true);
      await queryRunner.commitTransaction();
      const updated = result.affected ?? 0;
      this.logger.log(`[HeadOpenBal] Applied year ${yearcode} → ${updated} accounts updated`);
      return { success: true, message: `Applied year ${yearcode} balances to ${updated} account heads.`, updated };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof HttpException) throw error;
      throw new Error(`Failed to apply opening balances:${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }
}
