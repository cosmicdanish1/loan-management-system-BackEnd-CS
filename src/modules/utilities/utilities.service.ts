import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { UserPreference } from './entities/user-preference.entity';
import { SystemSetting } from './entities/system-setting.entity';
import { UpdateUserPreferenceDto } from './dto/update-user-preference.dto';
import { generateVoucherNo } from '../shared/utils/voucher-utils';
import { LoanEligibilityService } from '../loan/services-v2/loan-eligibility.service';

@Injectable()
export class UtilitiesService {
  private readonly logger = new Logger(UtilitiesService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(UserPreference)
    private readonly preferenceRepo: Repository<UserPreference>,
    @InjectRepository(SystemSetting)
    private readonly systemRepo: Repository<SystemSetting>,
    private readonly loanEligibilityService: LoanEligibilityService
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
      // BUG FIX 51: COALESCE was inside the subquery (`SELECT COALESCE(rate, 4.0) ... LIMIT 1`),
      // which only guards a returned row whose rate is NULL — it does nothing when the subquery
      // matches zero rows, and a zero-row scalar subquery evaluates to NULL as a whole regardless
      // of any COALESCE inside it. Confirmed live: interestmaster has 0 rows at all (for any
      // inttype), so "interestRate" came back NULL -> parseFloat(null) -> NaN on the frontend,
      // cascading into every dependent figure (penalty, applied rate, interest earned, net
      // payable all showed NaN on the SB Premature Information screen). Wrapping COALESCE
      // around the whole subquery instead correctly falls back to 4.0 whether the problem is a
      // missing row or a NULL rate within one.
      const query = `
        SELECT
          'SB-' || mbno as "accountNumber",
          mbno as "memberId",
          COALESCE((SELECT rate::numeric FROM interestmaster WHERE inttype = 'SB' ORDER BY todt DESC LIMIT 1), 4.0) as "interestRate",
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

  // Feature: Premature Information (RD/SB) previously required typing/looking up a
  // member number blind, with no way to tell in advance whether that member even
  // has the relevant account type — a search would just come back empty. These two
  // list the actual holders so the screen can offer a scoped dropdown instead.
  async listRdAccountHolders(): Promise<any[]> {
    const query = `
      SELECT
        f.mbno as "memberNo",
        TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')) as "memberName",
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
    // sbmaster is the real, authoritative SB account table (unlike searchSBAccounts
    // above, which synthesizes a balance from the ledger for lack of one) — reading
    // it directly here is simpler and just as correct for "who has an account".
    const query = `
      SELECT
        s.mbno as "memberNo",
        TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')) as "memberName",
        s.acc_no as "accountNumber",
        s.balance
      FROM sbmaster s
      LEFT JOIN member_master m ON s.mbno::text = m.mbno::text
      ORDER BY s.mbno
    `;
    return this.dataSource.query(query);
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

      // Get RD summary — RD accounts live in fdmaster (fdrdflag='R'), not
      // recurring_deposits, which nothing in the app ever writes to. See
      // searchDeposits() above for the reference column mapping.
      const rdQuery = `
        SELECT
          COUNT(*) as rd_accounts,
          COALESCE(SUM(openbal), 0) as total_rd_deposited,
          COALESCE(SUM(fdamount), 0) as total_monthly_installment
        FROM fdmaster
        WHERE mbno = $1
        AND fdrdflag = 'R'
        AND (status = '0' OR status IS NULL)
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

      // Loan balances (RLN = regular loan, ELN = emergency loan) from member_balances
      const loanQuery = `
        SELECT
          COALESCE(regularloan, 0) as rln_balance,
          COALESCE(emergency_loan_balance, 0) as eln_balance,
          COALESCE(loanint_rate, 0) as rln_rate,
          COALESCE(eloanint_rate, 0) as eln_rate
        FROM member_balances
        WHERE mbno = $1
      `;
      const loanResult = await this.dataSource.query(loanQuery, [parseInt(memberNo)]);

      return {
        member: member,
        rd_summary: rdResult[0] || { rd_accounts: 0, total_rd_deposited: 0, total_monthly_installment: 0 },
        fd_summary: fdResult[0] || { fd_accounts: 0, total_fd_deposited: 0 },
        sb_summary: sbResult[0] || { sb_accounts: 0, total_sb_balance: 0 },
        loan_summary: loanResult[0] || { rln_balance: 0, eln_balance: 0, rln_rate: 0, eln_rate: 0 }
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
          'Emergency Loan' as name,
          'ELN' as code,
          elnrate as rate,
          elnmaxloanamt as max_amount,
          elnmaxnoinst as max_tenure,
          'Quick approval for urgent financial needs' as description
        FROM busrules 
        WHERE appdate = (SELECT MAX(appdate) FROM busrules)
        UNION ALL
        SELECT 
          'Advance Loan' as name,
          'ALN' as code,
          alnrate as rate,
          alnmaxloanamt as max_amount,
          alnmaxnoinst as max_tenure,
          'Salary advance with lower interest rates' as description
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
      const transDate = data.transferDate ? new Date(data.transferDate) : new Date();

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
      throw new Error(
        `Balance transfer failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
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
      bankCode?: string;
      narration: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[SavingTxn] Saving ${data.transactionType} for account=${data.accountNo} amount=${data.amount}`);

      // Get account details
      const accountResult = await queryRunner.query(
        `SELECT acc_no, mbno, balance, COALESCE(min_balance, 0) as min_balance FROM sbmaster WHERE acc_no = $1`,
        [data.accountNo]
      );

      if (!accountResult || accountResult.length === 0) {
        throw new Error(`Account ${data.accountNo} not found`);
      }

      const account = accountResult[0];
      const memberNo = account.mbno;

      // BUG FIX 25: this had no server-side check at all — it just computed
      // newBalance = balance - amount and wrote it, no matter what. The only thing stopping an
      // overdraft was the frontend comparing against withdrawableBalance, which is exactly the
      // kind of check that's already proven fragile this session (three separate frontend bugs
      // found and fixed on this same screen). Mirrors the frontend's own rule — balance can't
      // drop below the account's minimum — so a bypassed or buggy client can no longer withdraw
      // money the account doesn't have.
      if (data.transactionType === 'withdrawal') {
        const currentBalance = Number(account.balance) || 0;
        const minBalance = Number(account.min_balance) || 0;
        const amount = Number(data.amount) || 0;
        if (currentBalance - amount < minBalance) {
          throw new Error(
            `Insufficient balance. Withdrawable balance is ₹${(currentBalance - minBalance).toFixed(2)}. Requested amount ₹${amount.toFixed(2)} exceeds this limit.`
          );
        }
      }
      if (!data.amount || Number(data.amount) <= 0) {
        throw new Error('Transaction amount must be greater than zero.');
      }

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
      // Deposit = receipt (R), withdrawal = payment (P) — canonical voucher_master counters
      let voucherNo = data.voucherNo;
      if (!voucherNo) {
        voucherNo = await generateVoucherNo(queryRunner, isDeposit ? 'R' : 'P');
      }

      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      const modeOfPay = data.paymentMode === 'cash' ? 'C' : 'B';

      // ledger has no cheque_no/cheque_date/bank_name columns — the only bank
      // field is cust_bank_name. Both INSERTs below used to name all three,
      // so every deposit and withdrawal failed outright with a SQL error.
      // Cheque details are folded into the narration rather than dropped,
      // since there is nowhere in this table to hold them.
      const chequeRef = data.chequeNo
        ? ` [Cheque ${data.chequeNo}${data.chequeDate ? ' dt ' + new Date(data.chequeDate).toISOString().slice(0, 10) : ''}]`
        : '';
      const ledgerNarration = `${data.narration || ''}${chequeRef}`.trim();

      // Member SB account leg — CR on deposit (balance increases), DR on withdrawal.
      // Posts to A001 (Savings Bank Account control head) — NOT A1001 (Cash in Hand);
      // previously both legs used A1001, netting the SB head to zero in the general ledger.
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid, cust_bank_name)
         VALUES ($1, $2, $3, 'A001', $4, $5, 'SB', $6, $7, $8, $9, 0, $10, $11, $12, $13)`,
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
          ledgerNarration,
          username,
          nextLedgerId,
          data.bankName || null
        ]
      );

      // Cash/bank offsetting leg — DR on deposit (cash in), CR on withdrawal (cash out).
      // Bank mode uses the chosen bank account; cash uses A1001.
      const cashAccType = modeOfPay === 'B' ? 'BANK' : 'CINH';
      const cashCode = modeOfPay === 'B' ? (data.bankCode || 'A1008') : 'A1001';
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
          ledgerNarration,
          username,
          nextLedgerId + 1,
          data.bankName || null
        ]
      );

      // Update sbmaster balance. Postgres numeric comes back as a JS string, so coerce both
      // operands — otherwise `+` concatenates ("0.00" + 500 => "0.00500").
      const curBalance = Number(account.balance) || 0;
      const txnAmount = Number(data.amount) || 0;
      const newBalance = isDeposit
        ? curBalance + txnAmount
        : curBalance - txnAmount;

      await queryRunner.query(
        `UPDATE sbmaster SET balance = $1 WHERE acc_no = $2`,
        [newBalance, data.accountNo]
      );

      // Cash Book leg. Savings transactions move real cash across the counter,
      // but this path only ever wrote to ledger and sbmaster — so the Cash Book,
      // which is the record of what is actually in the drawer, never saw a
      // single deposit or withdrawal. A deposit is cash received, a withdrawal
      // is cash paid; bank mode goes to the transfer columns instead.
      const isCashMode = modeOfPay === 'C';
      await queryRunner.query(
        `INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
         VALUES ('A001', $1, $2, $3, $4, $5, $6)`,
        [
          isDeposit ? 'SAVINGS DEPOSIT' : 'SAVINGS WITHDRAWAL',
          isDeposit && isCashMode ? data.amount : 0,
          isDeposit && !isCashMode ? data.amount : 0,
          !isDeposit && isCashMode ? data.amount : 0,
          !isDeposit && !isCashMode ? data.amount : 0,
          transDate,
        ]
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
              depperiod as "depositPeriod", depunit as "depositUnit", intcalmethod as "intCalMethod", status
       FROM fdmaster WHERE mbno = $1 AND fdrdflag = 'F' AND status = '0'
       ORDER BY account_number`,
      [parseInt(memberNo)]
    );
    this.logger.log(`[FDInterest] Found ${result.length} active FDs for member ${memberNo}`);
    return result;
  }

  // BUG FIX 22: this used to return { success, data: account } itself, and the global
  // TransformInterceptor (main.ts) wraps every controller response in its own { success, data }
  // envelope on top of that — so the real account object ended up at response.data.data, not
  // response.data. Confirmed live: the frontend read response.data expecting the account
  // directly, got the inner wrapper object instead, and every field (currentBalance,
  // transactionHistory, ...) silently fell back to its default (0 / []). The account number
  // showed in the box but the balance panel and history always looked empty even for a real,
  // funded account. Returning the account (or null) directly here lets the interceptor's single
  // wrap be the only one — no frontend change needed, response.data is now the real account.
  async getSavingAccountDetails(accountNo: string): Promise<any> {
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
        return null;
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
      return account;
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
      expenseHeadCode?: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    // BUG FIX 46: no validation existed — a missing/zero/negative interest amount
    // would still post a real ledger entry pair for that amount.
    const interestAmount = Number(data.interestAmount);
    if (!data.memberNo || !data.accountNumber) {
      throw new BadRequestException('Member and FD account are required');
    }
    if (!interestAmount || interestAmount <= 0) {
      throw new BadRequestException('Interest Amount must be greater than 0');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[FDInterest] Posting interest for FD ${data.accountNumber} amount=${data.interestAmount}`);

      // BUG FIX 46: unguarded MAX()+1 — same systemic concurrency gap fixed
      // elsewhere this session.
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);

      // Get next trans_no and ledgerid
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // FD interest accrual is a journal entry — canonical voucher_master J counter
      const voucherNo = await generateVoucherNo(queryRunner, 'J');

      const transDate = data.transDate ? new Date(data.transDate) : new Date();

      // CR A003 (FD liability) — interest accrued increases the member's FD balance
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', 'A003', $3, $4, 'FD', $5, $6, 'J', 'C', 0, $7, $8, $9)`,
        [nextTransNo, transDate, data.memberNo, data.accountNumber, data.interestAmount, voucherNo, data.narration || 'FD Interest Credit', username, nextLedgerId]
      );

      // DR Interest on FD (expense head) — balancing debit to record the expense.
      // BUG FIX: this crashed on every single call — `busrules.fdinthead` doesn't
      // exist (confirmed live: "column \"fdinthead\" does not exist"). Same class
      // of nonexistent-column gap already found and fixed for sbinthead/rdinthead
      // in interest.service.ts during the Interest Calculation Fixed segment —
      // that fix made the expense head caller-configurable via the DTO instead of
      // querying a column that was never real; mirrored here the same way. No GL
      // head has been confirmed correct for this purpose (same open question as
      // that earlier fix), so L1028 remains only as the already-flagged placeholder.
      const intExpenseCode = data.expenseHeadCode || 'L1028';
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

  /**
   * Pay accrued FD interest OUT to the member (the FD stays open).
   * DR A003/FD (reduce the accrued interest held in the FD) + CR cash/bank (money paid out).
   * Payment voucher (vchr_type 'P', voucher_master P counter). Records the payment on fdmaster.
   */
  async payFdInterest(
    data: {
      memberNo: number;
      accountNumber: number;
      certNo?: string;
      interestAmount: number;
      transDate?: string;
      paymentMode?: string;
      bankCode?: string;
      chequeNo?: string;
      bankName?: string;
      narration?: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const amount = Number(data.interestAmount) || 0;
      if (amount <= 0) throw new Error('Interest amount must be greater than zero');

      // BUG FIX: missing the same advisory lock its sibling postFdInterestVoucher
      // (just above) already has — inconsistent gap in the same fix batch.
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);

      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // FD interest payout is a payment to the member — voucher_master P counter
      const voucherNo = await generateVoucherNo(queryRunner, 'P');
      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      const modeOfPay = data.paymentMode === 'bank' ? 'B' : 'C';
      const narration = data.narration || `FD Interest Payout - ${data.certNo || data.accountNumber}`;

      // DR A003 (FD liability) — paying interest out reduces the accrued interest in the FD
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', 'A003', $3, $4, 'FD', $5, $6, 'P', $7, 0, $8, $9, $10)`,
        [nextTransNo, transDate, data.memberNo, data.accountNumber, amount, voucherNo, modeOfPay, narration, username, nextLedgerId]
      );

      // CR cash/bank — money paid out (asset decreases). Bank mode credits the chosen account.
      const crCode = modeOfPay === 'B' ? (data.bankCode || 'A1008') : 'A1001';
      const crAccType = modeOfPay === 'B' ? 'BANK' : 'CINH';
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', $3, $4, 0, $5, $6, $7, 'P', $8, 0, $9, $10, $11)`,
        [nextTransNo + 1, transDate, crCode, data.memberNo, crAccType, amount, voucherNo, modeOfPay, narration, username, nextLedgerId + 1]
      );

      // Record the payout on fdmaster (FD stays open)
      await queryRunner.query(
        `UPDATE fdmaster SET lastintpaydate = $1, intpaid = COALESCE(intpaid, 0) + $2 WHERE account_number = $3`,
        [transDate, amount, data.accountNumber]
      );

      await queryRunner.commitTransaction();
      this.logger.log(`[FDInterest] Paid out vchr=${voucherNo} FD=${data.accountNumber} amount=${amount}`);
      return { success: true, transNo: nextTransNo, voucherNo, message: `FD interest paid out. Voucher: ${voucherNo}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[FDInterest] Payout failed:`, error);
      throw new Error(`Failed to pay FD interest: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
      operationMode?: number;
      headCode?: string;
      nomineeName?: string;
      nomineeAge?: string;
      nomineeAddress?: string;
      nomineeRelation?: string;
      nominees?: Array<{ name?: string; age?: number | string; address?: string; relation?: string }>;
      paymentMode: string;
      chequeNo?: string;
      bankName?: string;
      bankCode?: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; accountNumber: number; voucherNo: string; message: string }> {
    // BUG FIX 46: this endpoint (the one the real UI actually calls, unlike
    // fixed-deposit.service.ts's createFixedDeposit) had no validation at all — a
    // missing/invalid amount, period, or rate would silently insert whatever was
    // sent (or NULL). Mirrors the validation already added to the dead-code path.
    const errors: string[] = [];
    if (!data.memberNo) errors.push('Member is required');
    const depositAmount = Number(data.depositAmount);
    if (!depositAmount || depositAmount <= 0) errors.push('Deposit Amount must be greater than 0');
    const depositPeriod = Number(data.depositPeriod);
    if (!depositPeriod || depositPeriod <= 0) errors.push('Deposit Period must be greater than 0');
    const rate = Number(data.rate);
    if (data.rate === undefined || data.rate === null || (data.rate as any) === '' || isNaN(rate) || rate < 0) {
      errors.push('Rate must be a valid non-negative number');
    }
    if (!data.depositDate) errors.push('Deposit Date is required');
    if (errors.length > 0) {
      throw new BadRequestException(errors);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[FDReceipt] Creating FD for member ${data.memberNo} amount=${data.depositAmount}`);

      // BUG FIX 46: no duplicate-certificate check existed — confirmed live, two FDs
      // for the same member were created with the identical certificate number
      // ("45"). certno is used as a lookup key by closeFixedDeposit/postFdInterestVoucher
      // (WHERE certno = ... AND mbno = ...), so a duplicate makes those ambiguous —
      // a close/interest-post could silently affect more than one FD at once.
      if (data.certificateNo) {
        const dup = await queryRunner.query(
          `SELECT account_number FROM fdmaster WHERE certno = $1 AND mbno = $2`,
          [data.certificateNo, data.memberNo]
        );
        if (dup.length > 0) {
          throw new ConflictException(
            `Certificate No '${data.certificateNo}' is already used by account ${dup[0].account_number} for this member`
          );
        }
      }

      // BUG FIX 46: both MAX()-based id reads below were unguarded — same systemic
      // concurrency gap already fixed elsewhere in utilities.service.ts and other
      // services this session (no unique constraint on account_number/trans_no/
      // ledgerid, confirmed via pg_constraint). Transaction-scoped advisory locks
      // serialize concurrent callers without needing new sequence objects.
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('fdmaster_account_number'))`);

      // Get next account number for FD
      const maxAccResult = await queryRunner.query(
        `SELECT COALESCE(MAX(account_number), 500000) + 2 AS next_acc FROM fdmaster WHERE fdrdflag = 'F'`
      );
      const accountNumber = Number(maxAccResult[0]?.next_acc ?? 500001);

      // BUG FIX 47: this only looks at FD's own rows (fdrdflag='F') when picking the
      // next number, and RD's generator (rd-account.service.ts) only looks at its
      // own too before this fix — account_number is shared across both, so the two
      // could independently compute and insert the same number even under perfect
      // locking (this isn't a race condition, it's two formulas with different
      // scopes over one shared column). A fresh existence check across the whole
      // table, under the same advisory lock RD now also takes, closes this side.
      const accDup = await queryRunner.query(
        `SELECT fdrdflag FROM fdmaster WHERE account_number = $1`, [accountNumber]
      );
      if (accDup.length > 0) {
        throw new Error(`Account number ${accountNumber} is already in use — please retry.`);
      }

      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);

      // Get next trans_no and ledgerid
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // FD opening is a receipt of deposit money — canonical voucher_master R counter
      const voucherNo = await generateVoucherNo(queryRunner, 'R');

      const depDate = data.depositDate ? new Date(data.depositDate) : new Date();
      const matDate = data.maturityDate ? new Date(data.maturityDate) : new Date();
      const modeOfPay = data.paymentMode === 'bank' ? 'B' : 'C';

      // Insert into fdmaster
      await queryRunner.query(
        `INSERT INTO fdmaster (mbno, account_number, prefix, f_name, m_name, l_name, certno, depunit, depperiod, rate, depdate, matdate, fdamount, matamount, interestbalance, interestpayamentmode, interestamount, intpaid, status, nominee, nage, naddr, nrelation, fdrdflag, remarks, openbal, operationmode, intcalmethod, headcode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15, $16, 0, '0', $17, $18, $19, $20, 'F', '', 0, $21, $22, $23)`,
        [
          data.memberNo, accountNumber,
          data.prefix || '', data.firstName || '', data.middleName || '', data.lastName || '',
          data.certificateNo || `FD${accountNumber}`,
          data.depositUnit || 1, data.depositPeriod || 12,
          data.rate, depDate, matDate,
          data.depositAmount, data.maturityAmount,
          data.modeOfPayment || 1, data.intAmount || 0,
          data.nomineeName || '', data.nomineeAge || '', data.nomineeAddress || '', data.nomineeRelation || '',
          data.operationMode || 1, data.intCalMethod || 1, data.headCode || 'A003'
        ]
      );

      // CR A003 (FD liability account) — deposit received increases society's liability
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', $3, $4, $5, 'FD', $6, $7, 'R', $8, 0, 'Fixed Deposit Opening', $9, $10)`,
        [nextTransNo, depDate, data.headCode || 'A003', data.memberNo, accountNumber, data.depositAmount, voucherNo, modeOfPay, username, nextLedgerId]
      );

      // DR cash/bank — the asset (cash received) must increase to balance the entry.
      // Bank mode debits the chosen bank account (BANK); cash debits A1001 (CINH).
      const cashCode = modeOfPay === 'B' ? (data.bankCode || 'A1008') : 'A1001';
      const cashAccType = modeOfPay === 'B' ? 'BANK' : 'CINH';
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', $3, $4, 0, $5, $6, $7, 'R', $8, 0, 'Fixed Deposit Opening - Cash/Bank', $9, $10)`,
        [nextTransNo + 1, depDate, cashCode, data.memberNo, cashAccType, data.depositAmount, voucherNo, modeOfPay, username, nextLedgerId + 1]
      );

      // Nominees → fd_nominee (multi-nominee, mirrors loan_nominee). Table is created
      // on first use (idempotent) since the schema has no FD nominee table yet.
      const nominees = (data.nominees || []).filter(n => (n.name || '').toString().trim());
      if (nominees.length > 0) {
        await queryRunner.query(`
          CREATE TABLE IF NOT EXISTS fd_nominee (
            id SERIAL PRIMARY KEY,
            account_number numeric,
            mbno numeric,
            srno smallint,
            name varchar(100),
            address varchar(200),
            age smallint,
            relation varchar(50)
          )
        `);
        for (let i = 0; i < nominees.length; i++) {
          const n = nominees[i];
          await queryRunner.query(
            `INSERT INTO fd_nominee (account_number, mbno, srno, name, address, age, relation)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [accountNumber, data.memberNo, i + 1, (n.name || '').toString(), (n.address || '').toString(), parseInt(String(n.age)) || 0, (n.relation || '').toString()]
          );
        }
      }

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
    const result = await this.dataSource.query(
      `SELECT id, mbno, year, share_amount as "shareAmount", dividend_rate as "dividendRate", 
              dividend_amount as "dividendAmount", is_paid as "isPaid", voucher_no as "voucherNo"
       FROM dividend_master 
       WHERE mbno = $1 AND (is_paid IS NULL OR is_paid = 'N')
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
      transDate?: string;
      chequeNo?: string;
      chequeDate?: string;
      bankName?: string;
      bankCode?: string;
      narration?: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[Dividend] Processing payment for member ${data.memberNo} amount=${data.totalAmount}`);

      // BUG FIX: same missing-lock gap as saveReceipt just above — this also posts
      // directly to the real ledger with no approval gate.
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);

      // Get next trans_no and ledgerid
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // Dividend voucher number from voucher_master (D counter) — per the legacy
      // Demand/Dividend series, not the Receipt (R) counter.
      const voucherNo = await generateVoucherNo(queryRunner, 'D');

      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      const modeOfPay = data.paymentMode === 'bank' ? 'B' : 'C';
      const memberNoInt = parseInt(data.memberNo);

      // DR L1024 (Dividend Paid) — OTH
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', 'L1024', $3, 0, 'OTH', $4, $5, 'P', $6, 0, $7, $8, $9)`,
        [nextTransNo, transDate, memberNoInt, data.totalAmount, voucherNo, modeOfPay, data.narration || 'Dividend Payment', username, nextLedgerId]
      );

      // Balancing CR to cash/bank (double-entry): dividend paid OUT → DR L1024 + CR Cash/Bank.
      // Bank mode credits the chosen bank account (not a hardcoded one); cash credits A1001.
      const crCode    = modeOfPay === 'B' ? (data.bankCode || 'A1008') : 'A1001';
      const crAccType = modeOfPay === 'B' ? 'BANK'  : 'CINH';

      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', $3, $4, 0, $5, $6, $7, 'P', $8, 0, $9, $10, $11)`,
        [nextTransNo + 1, transDate, crCode, memberNoInt, crAccType, data.totalAmount, voucherNo, modeOfPay, data.narration || 'Dividend Payment', username, nextLedgerId + 1]
      );

      // Mark dividends as paid
      if (data.dividendIds && data.dividendIds.length > 0) {
        await queryRunner.query(
          `UPDATE dividend_master SET is_paid = 'Y', payment_date = $1, payment_mode = $2, cheque_no = $3, voucher_no = $4
           WHERE id = ANY($5)`,
          [transDate, data.paymentMode, data.chequeNo || '', voucherNo, data.dividendIds]
        );
      }

      await queryRunner.commitTransaction();
      this.logger.log(`[Dividend] Paid vchr=${voucherNo} member=${data.memberNo} amount=${data.totalAmount} crCode=${crCode}`);

      return { success: true, voucherNo, message: `Dividend payment ${voucherNo} processed. Amount: ${data.totalAmount}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[Dividend] Failed:`, error);
      throw new Error(`Failed to process dividend: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async saveReceipt(
    data: {
      memberNo: number;
      voucherNo: string;
      transDate: string;
      modeOfPay: string;
      bankCode: string;   // which bank to DR (A1008 etc.)
      narration: string;
      rows: Array<{ code: string; accType: string; amount: number }>;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[Receipt] Saving receipt for member ${data.memberNo} rows=${data.rows.length}`);

      // BUG FIX: no unique constraint on ledger.trans_no/ledgerid (NOT NULL only) —
      // this posts directly to the real ledger with no Pass Transactions approval
      // gate, so an unguarded MAX()+1 race here immediately corrupts live financial
      // data, not just a pending queue. 'ledger' is the same lock key
      // member-balance-transfer.service.ts already uses for the same table.
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);

      // Get next trans_no and ledgerid
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      let nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      let nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // Generate R voucher number if not provided — canonical voucher_master R counter
      let voucherNo = data.voucherNo;
      if (!voucherNo) {
        voucherNo = await generateVoucherNo(queryRunner, 'R');
      }

      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      const totalAmount = data.rows.reduce((s, r) => s + r.amount, 0);
      const modeOfPay = data.modeOfPay || 'B';
      const bankCode = data.bankCode || 'A1008';

      // Derive the canonical acc_type for each row's code from ledger history
      // (authoritative & complete — replaces the limited hardcoded frontend map).
      const codes = data.rows.map(r => r.code).filter(Boolean);
      const accTypeMap: Record<string, string> = {};
      if (codes.length > 0) {
        const accRows = await queryRunner.query(
          `SELECT code, acc_type FROM (
             SELECT code, acc_type, ROW_NUMBER() OVER (PARTITION BY code ORDER BY COUNT(*) DESC) AS rn
             FROM ledger WHERE code = ANY($1) AND acc_type IS NOT NULL AND acc_type <> ''
             GROUP BY code, acc_type
           ) t WHERE rn = 1`,
          [codes]
        );
        for (const r of accRows) accTypeMap[r.code] = r.acc_type;
      }

      // CR entries for each row (vchr_type='R') — loan recovery, interest, etc.
      for (const row of data.rows) {
        if (!row.code || !row.amount) continue;
        const accType = accTypeMap[row.code] || row.accType || 'OTH';
        await queryRunner.query(
          `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
           VALUES ($1, $2, 'CR', $3, $4, 0, $5, $6, $7, 'R', $8, 0, $9, $10, $11)`,
          [nextTransNo++, transDate, row.code, data.memberNo, accType, row.amount, voucherNo, modeOfPay, data.narration || '', username, nextLedgerId++]
        );
      }

      // BUG FIX: DR cash (A1001/CINH) for cash mode, DR bank head for bank mode.
      // Previously acc_type was hardcoded 'BANK' regardless of modeOfPay, so cash
      // receipts were incorrectly posted to the bank account in the ledger.
      const drCode    = modeOfPay === 'C' ? 'A1001' : bankCode;
      const drAccType = modeOfPay === 'C' ? 'CINH'  : 'BANK';

      // DR cash/bank account (vchr_type='P') — same voucher number, total amount
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', $3, $4, 0, $5, $6, $7, 'P', $8, 0, $9, $10, $11)`,
        [nextTransNo++, transDate, drCode, data.memberNo, drAccType, totalAmount, voucherNo, modeOfPay, data.narration || '', username, nextLedgerId++]
      );

      await queryRunner.commitTransaction();
      this.logger.log(`[Receipt] Saved vchr=${voucherNo} member=${data.memberNo} total=${totalAmount} rows=${data.rows.length}`);

      return { success: true, transNo: nextTransNo - data.rows.length - 1, voucherNo, message: `Receipt ${voucherNo} saved. Total: ${totalAmount}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[Receipt] Failed:`, error);
      throw new Error(`Failed to save receipt: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async saveReceiptVoucher(
    data: {
      memberNo: number;
      paymentType?: string;
      voucherNo: string;
      transDate: string;
      modeOfPay: string;
      narration: string;
      cheqNo?: string;
      cheqDate?: string;
      bankName?: string;
      receiveIntoCode?: string;
      rows: Array<{ code: string; accType: string; amount: number }>;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[VoucherPayment] Staging receipt for member ${data.memberNo} rows=${data.rows.length}`);

      const voucherNo = data.voucherNo || await generateVoucherNo(queryRunner, 'R');
      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      const totalAmount = data.rows.reduce((s, r) => s + r.amount, 0);
      const modeOfPay = data.modeOfPay || 'C';
      const isBank = modeOfPay === 'B';
      const receiveIntoCode = isBank ? (data.receiveIntoCode || 'A1001') : 'A1001';

      // BUG FIX: same missing-lock gap as savePaymentVoucher just above — locking
      // on both keys other id-generating services already use is what actually
      // serializes against them, not just against concurrent calls to this function.
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('vouchers'))`);
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('transactions'))`);

      // 1. Insert vouchers header with PENDING status
      const nextVoucherId = await queryRunner.query(
        `SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM vouchers`
      );
      const voucherId = Number(nextVoucherId[0]?.next_id ?? 1);

      await queryRunner.query(
        `INSERT INTO vouchers (
          "id", "voucherNumber", "voucherDate", "voucherType", "totalAmount",
          "description", "memberId", "payeeName", "status", "remarks",
          "chequeNumber", "chequeDate", "bankName", "createdAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          voucherId,
          voucherNo,
          transDate,
          'RECEIPT',
          totalAmount,
          data.narration || '',
          data.memberNo,
          '',
          'PENDING',
          `RECEIVE_INTO:${receiveIntoCode}|PAY_MODE:${isBank ? 'BANK' : 'CASH'}`,
          data.cheqNo || null,
          data.cheqDate ? new Date(data.cheqDate) : null,
          data.bankName || null,
          new Date(),
        ]
      );

      // 2. DR the receiving account (cash/bank)
      const receiveAccType = isBank && receiveIntoCode !== 'A1001' ? 'BANK' : 'CINH';
      let nextTransNo = Number((await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no FROM transactions`
      ))[0]?.next_trans_no ?? 1);
      const firstTransNo = nextTransNo;

      await queryRunner.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, cheq_no, cheq_amt, cheq_date, bankname, pass_flag, cashier_flag, code, narration, username)
         VALUES ($1, 'DR', $2, $3, 0, $4, $5, $6, 'R', $7, $8, 0, $9, $10, 'N', 'Y', $11, $12, $13)`,
        [nextTransNo++, transDate, data.memberNo, receiveAccType, totalAmount, voucherNo, modeOfPay,
         data.cheqNo || '', data.cheqDate ? new Date(data.cheqDate) : null, data.bankName || '',
         receiveIntoCode, data.narration || '', username]
      );

      // Derive the canonical acc_type for each row's code from ledger history
      const codes = data.rows.map(r => r.code).filter(Boolean);
      const accTypeMap: Record<string, string> = {};
      if (codes.length > 0) {
        const accRows = await queryRunner.query(
          `SELECT code, acc_type FROM (
             SELECT code, acc_type, ROW_NUMBER() OVER (PARTITION BY code ORDER BY COUNT(*) DESC) AS rn
             FROM ledger WHERE code = ANY($1) AND acc_type IS NOT NULL AND acc_type <> ''
             GROUP BY code, acc_type
           ) t WHERE rn = 1`,
          [codes]
        );
        for (const r of accRows) accTypeMap[r.code] = r.acc_type;
      }

      // 3. CR each row (loan recovery, interest income, etc.)
      for (const row of data.rows) {
        if (!row.code || !row.amount) continue;
        const accType = accTypeMap[row.code] || row.accType || 'OTH';
        await queryRunner.query(
          `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, cheq_no, cheq_amt, cheq_date, bankname, pass_flag, cashier_flag, code, narration, username)
           VALUES ($1, 'CR', $2, $3, 0, $4, $5, $6, 'R', $7, $8, 0, $9, $10, 'N', 'Y', $11, $12, $13)`,
          [nextTransNo++, transDate, data.memberNo, accType, row.amount, voucherNo, modeOfPay,
           data.cheqNo || '', data.cheqDate ? new Date(data.cheqDate) : null, data.bankName || '',
           row.code, data.narration || '', username]
        );
      }

      await queryRunner.commitTransaction();
      this.logger.log(`[VoucherPayment] Staged vchr=${voucherNo} member=${data.memberNo} total=${totalAmount} rows=${data.rows.length} → Pass Transactions`);

      return { success: true, transNo: firstTransNo, voucherNo, message: `Voucher ${voucherNo} staged (pending pass). Total: ${totalAmount}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[VoucherPayment] Failed:`, error);
      throw new Error(`Failed to save voucher payment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async savePaymentVoucher(
    data: {
      memberNo: number;
      voucherNo: string;
      transDate: string;
      paymentType: string;
      officeNo?: string;
      narration: string;
      payFromCode?: string;
      rows: Array<{ code: string; name: string; amount: number; rdSrNo?: string }>;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[PaymentVoucher] Staging payment for member ${data.memberNo} rows=${data.rows?.length}`);

      const voucherNo = data.voucherNo || await generateVoucherNo(queryRunner, 'P');
      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      const rows = data.rows || [];
      const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
      const payFromCode = (data.payFromCode || 'A1001').trim();
      const isCash = payFromCode === 'A1001';
      const modeOfPay = isCash ? 'C' : 'B';

      // BUG FIX: no unique constraint on vouchers.id/transactions.trans_no (NOT
      // NULL only, confirmed via information_schema, same as every other MAX()+1
      // site already fixed this session) — an unguarded read here lets two
      // concurrent saves (including from *other* features — Journal Transfer, CD,
      // Member Balance Transfer all generate the same two sequences) silently
      // compute and insert duplicate ids. Locking on both 'vouchers' and
      // 'transactions' — the same two keys those other services already lock on —
      // is what actually serializes against them, not just against itself.
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('vouchers'))`);
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('transactions'))`);

      // 1. Insert into vouchers table with PENDING status
      const nextVoucherId = await queryRunner.query(
        `SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM vouchers`
      );
      const voucherId = Number(nextVoucherId[0]?.next_id ?? 1);

      await queryRunner.query(
        `INSERT INTO vouchers (
          "id", "voucherNumber", "voucherDate", "voucherType", "totalAmount",
          "description", "memberId", "payeeName", "status", "remarks",
          "chequeNumber", "chequeDate", "bankName", "createdAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          voucherId,
          voucherNo,
          transDate,
          'PAYMENT',
          total,
          data.narration || '',
          data.memberNo,
          '',
          'PENDING',
          `PAY_FROM:${payFromCode}|PAY_MODE:${isCash ? 'CASH' : 'BANK'}`,
          null,
          null,
          isCash ? null : payFromCode,
          new Date(),
        ]
      );

      // 2. Insert DR rows into transactions table with pass_flag = 'N'
      let firstTransNo = 0;
      for (const row of rows) {
        if (!row.code || !row.amount) continue;
        const transNoResult = await queryRunner.query(
          `SELECT COALESCE(MAX(trans_no), 0) + 1 as next_id FROM transactions`
        );
        const transNo = Number(transNoResult[0]?.next_id ?? 1);
        if (!firstTransNo) firstTransNo = transNo;

        await queryRunner.query(
          `INSERT INTO transactions (
            trans_no, trans_type, trans_date, mbno, trans_amt,
            receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
            narration, code, username, acc_no, cheq_amt
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            transNo,
            'P',
            transDate,
            data.memberNo,
            row.amount,
            voucherNo,
            'PV',
            modeOfPay,
            'N',
            'N',
            data.narration || row.name || '',
            row.code,
            username,
            row.rdSrNo ? parseInt(row.rdSrNo.replace(/[^0-9]/g, '')) || null : null,
            0,
          ]
        );
      }

      // 3. Insert CR row for the "pay from" account (balancing entry)
      if (total > 0) {
        const crTransNoResult = await queryRunner.query(
          `SELECT COALESCE(MAX(trans_no), 0) + 1 as next_id FROM transactions`
        );
        const crTransNo = Number(crTransNoResult[0]?.next_id ?? 1);

        await queryRunner.query(
          `INSERT INTO transactions (
            trans_no, trans_type, trans_date, mbno, trans_amt,
            receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
            narration, code, username, acc_no, cheq_amt
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            crTransNo,
            'R',
            transDate,
            data.memberNo,
            total,
            voucherNo,
            'PV',
            modeOfPay,
            'N',
            'N',
            data.narration || '',
            payFromCode,
            username,
            null,
            0,
          ]
        );
      }

      await queryRunner.commitTransaction();
      this.logger.log(`[PaymentVoucher] Staged vchr=${voucherNo} member=${data.memberNo} total=${total} rows=${rows.length} → Pass Transactions`);

      return { success: true, transNo: firstTransNo, voucherNo, message: `Payment voucher ${voucherNo} saved (pending pass). Total: ${total}` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[PaymentVoucher] Failed:`, error);
      throw new Error(`Failed to save payment voucher: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    // --- Share Value & FD Eligibility rule check ---
    await this.loanEligibilityService.enforceEligibility(data.memberNo.toString(), data.loanAmount);

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
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      const transDate = data.transDate ? new Date(data.transDate) : new Date();

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
    // Join headmaster with balancesheet to get financial data
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
      LEFT JOIN balancesheet bs ON bs.head_code = hm.code
      ORDER BY hm.code
    `);
    return result;
  }

  async rebuildBalancesheet(): Promise<{ success: boolean; message: string; leafCount: number }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log('[BuildTree] Rebuilding balancesheet from ledger...');

      // Clear existing balancesheet
      await queryRunner.query(`DELETE FROM balancesheet`);

      // Rebuild from ledger in one CTE-based INSERT.
      // Leaf nodes = codes that are NOT listed as parent_code of any other headmaster row,
      // excluding M1000 (root) and orphan nodes (parent_code is null / '' / '0').
      // Closing balance formula:
      //   L/I accounts (credit-normal): opening = -op_bal, closing = op_bal + CR - DR
      //   A/E accounts (debit-normal):  opening = +op_bal, closing = op_bal + DR - CR
      // BUG FIX: queryRunner.query() only returns raw.rows by default, which is
      // empty for an INSERT with no RETURNING clause — result[1] was always
      // undefined, so leafCount always reported 0 even though rows were really
      // inserted (confirmed live: head-master data populated correctly, but the
      // response claimed "0 accounts updated"). useStructuredResult:true exposes
      // raw.rowCount via .affected instead.
      const result = await queryRunner.query(`
        INSERT INTO balancesheet
          (head_code, parent_code, head_name, opening_balance, debit, credit,
           closingbalance, closingbal_db, closing_cr, maincd)
        SELECT
          hm.code,
          hm.parent_code,
          hm.head_name,
          -- opening: stored negative for credit-normal (L/I), positive for debit-normal (A/E)
          CASE WHEN hm.code LIKE 'L%' OR hm.code LIKE 'I%'
               THEN -COALESCE(hm.op_bal, 0)
               ELSE  COALESCE(hm.op_bal, 0) END AS opening_balance,
          COALESCE(lag.total_dr, 0) AS debit,
          COALESCE(lag.total_cr, 0) AS credit,
          -- closing balance
          CASE WHEN hm.code LIKE 'L%' OR hm.code LIKE 'I%'
               THEN COALESCE(hm.op_bal, 0) + COALESCE(lag.total_cr, 0) - COALESCE(lag.total_dr, 0)
               ELSE COALESCE(hm.op_bal, 0) + COALESCE(lag.total_dr, 0) - COALESCE(lag.total_cr, 0)
               END AS closingbalance,
          -- closingbal_db: debit-normal accounts only
          CASE WHEN hm.code NOT LIKE 'L%' AND hm.code NOT LIKE 'I%'
               THEN GREATEST(0, COALESCE(hm.op_bal, 0) + COALESCE(lag.total_dr, 0) - COALESCE(lag.total_cr, 0))
               ELSE 0 END AS closingbal_db,
          -- closing_cr: credit-normal accounts only
          CASE WHEN hm.code LIKE 'L%' OR hm.code LIKE 'I%'
               THEN GREATEST(0, COALESCE(hm.op_bal, 0) + COALESCE(lag.total_cr, 0) - COALESCE(lag.total_dr, 0))
               ELSE 0 END AS closing_cr,
          CASE WHEN hm.code LIKE 'L%' THEN 1
               WHEN hm.code LIKE 'A%' THEN 2
               WHEN hm.code LIKE 'I%' THEN 3
               WHEN hm.code LIKE 'E%' THEN 4
               ELSE 2 END AS maincd
        FROM headmaster hm
        LEFT JOIN (
          SELECT code,
            SUM(CASE WHEN trans_type = 'DR' THEN trans_amt::numeric ELSE 0 END) AS total_dr,
            SUM(CASE WHEN trans_type = 'CR' THEN trans_amt::numeric ELSE 0 END) AS total_cr
          FROM ledger
          GROUP BY code
        ) lag ON lag.code = hm.code
        WHERE hm.code NOT IN (
          SELECT DISTINCT parent_code FROM headmaster
          WHERE parent_code IS NOT NULL AND parent_code != '' AND parent_code != '0'
        )
        AND hm.code != 'M1000'
        AND hm.parent_code IS NOT NULL
        AND hm.parent_code != ''
        AND hm.parent_code != '0'
      `, undefined, true);

      await queryRunner.commitTransaction();
      const leafCount = result.affected ?? 0;
      this.logger.log(`[BuildTree] Rebuilt ${leafCount} leaf balances from ledger`);

      return {
        success: true,
        message: `Balance sheet rebuilt from ledger. ${leafCount} accounts updated.`,
        leafCount,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('[BuildTree] Failed:', error);
      throw new Error(`Failed to rebuild balance sheet: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }

  async deleteHeadMaster(code: string): Promise<{ success: boolean; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const children = await queryRunner.query(
        `SELECT COUNT(*)::int AS cnt FROM headmaster WHERE parent_code = $1`, [code]
      );
      if (children[0].cnt > 0) {
        throw new Error(`${code} has ${children[0].cnt} child heads — remove children first.`);
      }
      // BUG FIX: deleting a head with real ledger postings would silently drop
      // those transactions from every future rebuildBalancesheet() run — it
      // LEFT JOINs from headmaster, so a code no longer present there just
      // vanishes from the balance sheet instead of erroring. Same style of
      // guard as the existing children check above.
      const postings = await queryRunner.query(
        `SELECT COUNT(*)::int AS cnt FROM ledger WHERE code = $1`, [code]
      );
      if (postings[0].cnt > 0) {
        throw new Error(`${code} has ${postings[0].cnt} ledger transaction(s) posted against it — cannot delete.`);
      }
      await queryRunner.query(`DELETE FROM headmaster   WHERE code      = $1`, [code]);
      await queryRunner.query(`DELETE FROM balancesheet WHERE head_code = $1`, [code]);
      await queryRunner.commitTransaction();
      this.logger.log(`[DeleteHead] Deleted head ${code}`);
      return { success: true, message: `${code} deleted successfully.` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new Error(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      await queryRunner.release();
    }
  }

  async saveHeadMaster(data: any): Promise<{ success: boolean; message: string }> {
    if (!data.pflag || !String(data.pflag).trim()) {
      throw new Error('pflag is required (A=Asset, L=Liability, I=Income, E=Expenditure, R=Root)');
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
           data.interest || 'N', data.hposition || null, data.pflag,
           data.opBal || 0, data.code]
        );
      } else {
        // Insert
        await queryRunner.query(
          `INSERT INTO headmaster (code, parent_code, head_name, headtype, interest, hposition, pflag, op_bal)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [data.code, data.parentCode, data.headName, data.headType || null,
           data.interest || 'N', data.hposition || null, data.pflag,
           data.opBal || 0]
        );
      }

      await queryRunner.commitTransaction();
      return { success: true, message: `Head ${data.code} saved successfully.` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // BUG FIX: description was varchar(20) — unusably narrow for a real
      // descriptive label (confirmed live: a 28-char description crashed with
      // "value too long"). Same class of gap as usermaster's original
      // susername/spassword widths fixed earlier this session; widened once,
      // idempotently, the same way.
      try {
        await queryRunner.query(`ALTER TABLE "demandprintorder" ALTER COLUMN "description" TYPE varchar(100)`);
      } catch { /* already widened or column missing — safe to ignore */ }

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

      RULE_LOAN_LT_MAX_AMT: d.alnmaxloanamt,
      RULE_LOAN_LT_RATE: d.alnrate,
      RULE_LOAN_LT_INSTALLMENTS: d.alnmaxnoinst,
      RULE_LOAN_LT_GUARANTORS: d.alnnogr,
      RULE_LOAN_LT_PENAL_RATE: d.alnpenalrate,

      RULE_LOAN_MT_MAX_AMT: d.mlnmaxloanamt,
      RULE_LOAN_MT_RATE: d.mlnrate,
      RULE_LOAN_MT_INSTALLMENTS: d.mlnmaxnoinst,
      RULE_LOAN_MT_GUARANTORS: d.mlnnogr,

      RULE_LOAN_EMG_MAX_AMT: d.elnmaxloanamt,
      RULE_LOAN_EMG_RATE: d.elnrate,
      RULE_LOAN_EMG_INSTALLMENTS: d.elnmaxnoinst,
      RULE_LOAN_EMG_GUARANTORS: d.elnnogr,
      RULE_LOAN_EMG_PENAL_RATE: d.elnpenalrate,

      RULE_LOAN_DEP_MAX_AMT: d.edlmaxloanamt,
      RULE_LOAN_DEP_RATE: d.edlrate,
      RULE_LOAN_DEP_INSTALLMENTS: d.edlmaxnoinst,
      RULE_LOAN_DEP_GUARANTORS: d.edlnogr,

      // BUG FIX: "Share Value %" and "Basic Pay" both read the same column
      // (loanagainstbasic) — but that column name matches its sibling
      // loanagainstdeppercent ("FD %") exactly, so it's really "Basic Pay",
      // not "Share Value %". "Basic Pay" edits were also silently dropped on
      // save (never included in the INSERT below) no matter which field the
      // value came from. There is no real column backing "Share Value %" in
      // this legacy schema — it stays unbacked (frontend default 0) until a
      // real head/column is identified.
      RULE_LOAN_DEP_SHARE_VAL_PCT: undefined,
      RULE_LOAN_DEP_FD_PCT: d.loanagainstdeppercent,
      RULE_LOAN_DEP_OVERALL_LIMIT: d.loanmaxlimit,
      RULE_LOAN_DEP_BASIC_PAY: d.loanagainstbasic,

      RULE_MEMBER_MIN_TENURE_MONTHS: d.minmembship,
      RULE_SHARE_MIN_AMT: d.minshareamt,
      RULE_SHARE_MAX_AMT: d.maxshareamt,
      RULE_CD_MIN_AMT: d.mincdamt,
      RULE_CD_MAX_AMT: d.maxcdamt,
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
    const keys = ['RULE_FUND_INT_RATE', 'RULE_DIVIDEND_PCT', 'RULE_GRP_INSURANCE_AMT', 'RULE_CD_INTEREST_CHART'];
    const rows = await this.dataSource.query(
      `SELECT key, value, "dataType" FROM system_configs WHERE key = ANY($1) AND "isActive" = true`,
      [keys]
    );
    const out: Record<string, any> = {
      RULE_FUND_INT_RATE: 0,
      RULE_DIVIDEND_PCT: 0,
      RULE_GRP_INSURANCE_AMT: 0,
      RULE_CD_INTEREST_CHART: '[]',
    };
    for (const row of rows) {
      if (row.dataType === 'number' || row.dataType === 'percentage') {
        out[row.key] = Number(row.value) || 0;
      } else if (row.dataType === 'json') {
        try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = []; }
      } else {
        out[row.key] = row.value ?? out[row.key];
      }
    }
    return out;
  }

  async updateBusinessRules(data: Record<string, any>): Promise<{ success: boolean; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Insert a new busrules row with updated values (legacy pattern — each save creates new row)
      await queryRunner.query(
        `INSERT INTO busrules (
          appdate,
          rlnmaxloanamt, rlnrate, rlnpenalrate, rlnmaxnoinst, rlnnogr,
          elnmaxloanamt, elnrate, elnpenalrate, elnmaxnoinst, elnnogr,
          alnmaxloanamt, alnrate, alnpenalrate, alnmaxnoinst, alnnogr,
          mlnmaxloanamt, mlnrate, mlnmaxnoinst, mlnnogr,
          edlmaxloanamt, edlrate, edlmaxnoinst, edlnogr,
          minmembship, minshareamt, maxshareamt, mincdamt, maxcdamt,
          loanmaxlimit, loanagainstbasic, loanagainstdeppercent,
          dataentryflag, print_demand_horizontal, reducingbal_intt_calc,
          minsavingbalance, consolidateinttamountindemand, considerintt,
          intt_slot, profit_head_code, defaultduration
        ) VALUES (
          NOW(),
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19,
          $20, $21, $22, $23,
          $24, $25, $26, $27, $28,
          $29, $30, $31,
          $32, $33, $34,
          $35, $36, $37,
          $38, $39, $40
        )`,
        [
          data.RULE_LOAN_R_MAX_AMT || 0, data.RULE_LOAN_R_RATE || 0, data.RULE_PENAL_RATE || 0, data.RULE_LOAN_R_INSTALLMENTS || 0, data.RULE_LOAN_R_GUARANTORS || 0,
          data.RULE_LOAN_EMG_MAX_AMT || 0, data.RULE_LOAN_EMG_RATE || 0, data.RULE_LOAN_EMG_PENAL_RATE || 0, data.RULE_LOAN_EMG_INSTALLMENTS || 0, data.RULE_LOAN_EMG_GUARANTORS || 0,
          data.RULE_LOAN_LT_MAX_AMT || 0, data.RULE_LOAN_LT_RATE || 0, data.RULE_LOAN_LT_PENAL_RATE || 0, data.RULE_LOAN_LT_INSTALLMENTS || 0, data.RULE_LOAN_LT_GUARANTORS || 0,
          data.RULE_LOAN_MT_MAX_AMT || 0, data.RULE_LOAN_MT_RATE || 0, data.RULE_LOAN_MT_INSTALLMENTS || 0, data.RULE_LOAN_MT_GUARANTORS || 0,
          data.RULE_LOAN_DEP_MAX_AMT || 0, data.RULE_LOAN_DEP_RATE || 0, data.RULE_LOAN_DEP_INSTALLMENTS || 0, data.RULE_LOAN_DEP_GUARANTORS || 0,
          data.RULE_MEMBER_MIN_TENURE_MONTHS || 0, data.RULE_SHARE_MIN_AMT || 0, data.RULE_SHARE_MAX_AMT || 0, data.RULE_CD_MIN_AMT || 0, data.RULE_CD_MAX_AMT || 0,
          // BUG FIX: this column (loanagainstbasic) is "Basic Pay", not "Share
          // Value %" — see the read-side comment above for the naming evidence.
          // "Basic Pay" edits were previously never saved at all.
          data.RULE_LOAN_DEP_OVERALL_LIMIT || 0, data.RULE_LOAN_DEP_BASIC_PAY || 0, data.RULE_LOAN_DEP_FD_PCT || 0,
          data.SYS_DATA_ENTRY_MODE ? 'Y' : 'N',
          data.SYS_PRINT_DEMAND_HORIZONTAL ? 'Y' : 'N',
          data.SYS_USE_REDUCING_BALANCE ? 1 : 0,
          data.SYS_MIN_SAVINGS_BALANCE || 0,
          data.SYS_SHOW_CONSOLIDATED_INT_IN_DEMAND ? 1 : 0,
          data.SYS_CONSIDER_INT_BEFORE_10TH ? 'Y' : 'N',
          data.SYS_AVG_INT_CALC_SLOT || 0,
          data.SYS_PROFIT_HEAD || null,
          0, // defaultduration — NOT NULL, default 0
        ]
      );

      await queryRunner.commitTransaction();
      return { success: true, message: 'Business rules saved successfully.' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
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
         FROM balancesheet
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

  async getFinancialYears(): Promise<any[]> {
    // BUG FIX: this used to fabricate "01 Apr {yearcode-1} - 31 Mar {yearcode}"
    // from the yearcode's raw integer value — but yearcode is just a sequential
    // ID (1, 2, 3…), not a calendar year, so real data produced garbage like
    // "01 Apr 0 - 31 Mar 1" (confirmed live). The real dates already live on
    // the row itself (start_date/end_date), set once at creation by
    // FinancialYearService.createFinancialYear — just read them.
    const rows = await this.dataSource.query(
      `SELECT DISTINCT ON (yearcode) yearcode, start_date, end_date
       FROM yearend WHERE yearcode IS NOT NULL ORDER BY yearcode`
    );
    const fmt = (d: Date) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    return rows.map((r: any) => {
      const startDate = fmt(r.start_date);
      const endDate = fmt(r.end_date);
      return { yearcode: parseInt(r.yearcode), startDate, endDate, label: `${startDate} - ${endDate}` };
    });
  }

  async getHeadOpeningBalances(yearcode: number): Promise<any[]> {
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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        `DELETE FROM yearend_head WHERE yearcode = $1 AND head_code IN (SELECT code FROM headmaster)`,
        [yearcode],
      );
      for (const b of balances) {
        await queryRunner.query(
          `INSERT INTO yearend_head (yearcode, head_code, parent_code, closing_bal)
           SELECT $1, hm.code, hm.parent_code, $3 FROM headmaster hm WHERE hm.code = $2`,
          [yearcode, b.headCode, b.closingBal],
        );
      }
      await queryRunner.commitTransaction();
      this.logger.log(`[HeadOpenBal] Saved ${balances.length} balances for year ${yearcode}`);
      return { success: true, message: `Saved ${balances.length} head balances for year ${yearcode}.` };
    } catch (error) {
      await queryRunner.rollbackTransaction();
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
      `, [yearcode]);
      await queryRunner.commitTransaction();
      const updated = result[1] ?? 0;
      this.logger.log(`[HeadOpenBal] Applied year ${yearcode} → ${updated} accounts updated`);
      return { success: true, message: `Applied year ${yearcode} balances to ${updated} account heads.`, updated };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new Error(`Failed to apply opening balances: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await queryRunner.release();
    }
  }
}
