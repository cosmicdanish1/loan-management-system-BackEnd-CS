import { Injectable, Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { UserPreference } from './entities/user-preference.entity';
import { SystemSetting } from './entities/system-setting.entity';
import { UpdateUserPreferenceDto } from './dto/update-user-preference.dto';

@Injectable()
export class UtilitiesService {
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

      return {
        member: member,
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
      memberNo: number;
      voucherNo: string;
      transDate: string;
      transType: 'CR' | 'DR';
      accType: string;
      code: string;
      amount: number;
      vchrType: string;
      modeOfPay: string;
      narration: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[SavingTxn] Saving ${data.transType} CINH amount=${data.amount}`);

      // Get next trans_no and ledgerid
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // Generate voucher number — R for receipt, P for payment
      const isReceipt = data.transType === 'CR';
      const vchrType = isReceipt ? 'R' : 'P';
      let voucherNo = data.voucherNo;
      if (!voucherNo) {
        const vchrKey = isReceipt ? 'r_vchr_no' : 'p_vchr_no';
        const vmResult = await queryRunner.query(`SELECT ${vchrKey} FROM voucher_master LIMIT 1`);
        const lastNo = vmResult[0]?.[vchrKey] || (isReceipt ? 'R00000' : 'P00000');
        const prefix = isReceipt ? 'R' : 'P';
        const num = parseInt(lastNo.replace(/\D/g, '')) + 1;
        voucherNo = `${prefix}${num.toString().padStart(5, '0')}`;
        await queryRunner.query(`UPDATE voucher_master SET ${vchrKey} = $1`, [voucherNo]);
      }

      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      // Legacy pattern: mbno=0 for general CINH entries (no specific member)
      const mbno = data.memberNo || 0;

      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, $3, 'A1001', $4, 0, 'CINH', $5, $6, $7, $8, 0, $9, $10, $11)`,
        [nextTransNo, transDate, data.transType, mbno, data.amount, voucherNo, vchrType, data.modeOfPay || 'C', data.narration || '', username, nextLedgerId]
      );

      await queryRunner.commitTransaction();
      this.logger.log(`[SavingTxn] Saved trans_no=${nextTransNo} vchr=${voucherNo} type=${data.transType} amount=${data.amount}`);

      return { success: true, transNo: nextTransNo, voucherNo, message: `${isReceipt ? 'Receipt' : 'Payment'} ${voucherNo} saved. Amount: ${data.amount}` };
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
              depperiod as "depositPeriod", depunit as "depositUnit", status
       FROM fdmaster WHERE mbno = $1 AND fdrdflag = 'F' AND status = '0'
       ORDER BY account_number`,
      [parseInt(memberNo)]
    );
    this.logger.log(`[FDInterest] Found ${result.length} active FDs for member ${memberNo}`);
    return result;
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
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // Generate J voucher number
      const vmResult = await queryRunner.query(`SELECT j_vchr_no FROM voucher_master LIMIT 1`);
      const lastNo = vmResult[0]?.j_vchr_no || 'J00000';
      const num = parseInt(lastNo.replace(/\D/g, '')) + 1;
      const voucherNo = `J${num.toString().padStart(5, '0')}`;
      await queryRunner.query(`UPDATE voucher_master SET j_vchr_no = $1`, [voucherNo]);

      const transDate = data.transDate ? new Date(data.transDate) : new Date();

      // CR A003 (FD) — interest credit, vchr_type='J'
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', 'A003', $3, $4, 'FD', $5, $6, 'J', 'C', 0, $7, $8, $9)`,
        [nextTransNo, transDate, data.memberNo, data.accountNumber, data.interestAmount, voucherNo, data.narration || 'FD Interest Credit', username, nextLedgerId]
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
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // Generate receipt voucher number
      const vmResult = await queryRunner.query(`SELECT r_vchr_no FROM voucher_master LIMIT 1`);
      const lastNo = vmResult[0]?.r_vchr_no || 'R00000';
      const num = parseInt(lastNo.replace(/\D/g, '')) + 1;
      const voucherNo = `R${num.toString().padStart(5, '0')}`;
      await queryRunner.query(`UPDATE voucher_master SET r_vchr_no = $1`, [voucherNo]);

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

      // Insert into ledger — CR A003 (FD), vchr_type='R'
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'CR', 'A003', $3, $4, 'FD', $5, $6, 'R', $7, 0, 'Fixed Deposit Opening', $8, $9)`,
        [nextTransNo, depDate, data.memberNo, accountNumber, data.depositAmount, voucherNo, modeOfPay, username, nextLedgerId]
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
      chequeNo?: string;
      chequeDate?: string;
      bankName?: string;
      narration?: string;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[Dividend] Processing payment for member ${data.memberNo} amount=${data.totalAmount}`);

      // Get next trans_no and ledgerid
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // Generate voucher number from R_VCHR_NO
      const vmResult = await queryRunner.query(`SELECT r_vchr_no FROM voucher_master LIMIT 1`);
      const lastNo = vmResult[0]?.r_vchr_no || 'R00000';
      const num = parseInt(lastNo.replace(/\D/g, '')) + 1;
      const voucherNo = `R${num.toString().padStart(5, '0')}`;
      await queryRunner.query(`UPDATE voucher_master SET r_vchr_no = $1`, [voucherNo]);

      const transDate = new Date();
      const modeOfPay = data.paymentMode === 'bank' ? 'B' : 'C';

      // DR L1024 (Dividend Paid) — OTH
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', 'L1024', $3, 0, 'OTH', $4, $5, 'P', $6, 0, $7, $8, $9)`,
        [nextTransNo, transDate, parseInt(data.memberNo), data.totalAmount, voucherNo, modeOfPay, data.narration || 'Dividend Payment', username, nextLedgerId]
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
      this.logger.log(`[Dividend] Paid vchr=${voucherNo} member=${data.memberNo} amount=${data.totalAmount}`);

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

      // Get next trans_no and ledgerid
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      let nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      let nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // Generate R voucher number if not provided
      let voucherNo = data.voucherNo;
      if (!voucherNo) {
        const vmResult = await queryRunner.query(`SELECT r_vchr_no FROM voucher_master LIMIT 1`);
        const lastNo = vmResult[0]?.r_vchr_no || 'R00000';
        const num = parseInt(lastNo.replace(/\D/g, '')) + 1;
        voucherNo = `R${num.toString().padStart(5, '0')}`;
        await queryRunner.query(`UPDATE voucher_master SET r_vchr_no = $1`, [voucherNo]);
      }

      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      const totalAmount = data.rows.reduce((s, r) => s + r.amount, 0);
      const modeOfPay = data.modeOfPay || 'B';
      const bankCode = data.bankCode || 'A1008';

      // CR entries for each row (vchr_type='R') — loan recovery, interest, etc.
      for (const row of data.rows) {
        if (!row.code || !row.amount) continue;
        await queryRunner.query(
          `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
           VALUES ($1, $2, 'CR', $3, $4, 0, $5, $6, $7, 'R', $8, 0, $9, $10, $11)`,
          [nextTransNo++, transDate, row.code, data.memberNo, row.accType, row.amount, voucherNo, modeOfPay, data.narration || '', username, nextLedgerId++]
        );
      }

      // DR bank account (vchr_type='P') — same voucher number, total amount
      await queryRunner.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1, $2, 'DR', $3, $4, 0, 'BANK', $5, $6, 'P', $7, 0, $8, $9, $10)`,
        [nextTransNo++, transDate, bankCode, data.memberNo, totalAmount, voucherNo, modeOfPay, data.narration || '', username, nextLedgerId++]
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
      voucherNo: string;
      transDate: string;
      modeOfPay: string;
      narration: string;
      cheqNo?: string;
      cheqDate?: string;
      bankName?: string;
      rows: Array<{ code: string; accType: string; amount: number }>;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[VoucherPayment] Saving to TRANSACTIONS for member ${data.memberNo} rows=${data.rows.length}`);

      // Get next trans_no for transactions table
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no FROM transactions`
      );
      let nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);

      // Generate R voucher number if not provided (uses R_VCHR_NO from voucher_master)
      let voucherNo = data.voucherNo;
      if (!voucherNo) {
        const vmResult = await queryRunner.query(`SELECT r_vchr_no FROM voucher_master LIMIT 1`);
        const lastNo = vmResult[0]?.r_vchr_no || 'R00000';
        const num = parseInt(lastNo.replace(/\D/g, '')) + 1;
        voucherNo = `R${num.toString().padStart(5, '0')}`;
        await queryRunner.query(`UPDATE voucher_master SET r_vchr_no = $1`, [voucherNo]);
      }

      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      const totalAmount = data.rows.reduce((s, r) => s + r.amount, 0);
      const modeOfPay = data.modeOfPay || 'C';

      // CR CINH (A1001) — cash/bank received (total amount)
      await queryRunner.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, cheq_no, cheq_amt, cheq_date, bankname, pass_flag, cashier_flag, code, narration, username)
         VALUES ($1, 'CR', $2, $3, 0, 'CINH', $4, $5, 'P', $6, $7, 0, $8, $9, 'N', 'Y', 'A1001', $10, $11)`,
        [nextTransNo++, transDate, data.memberNo, totalAmount, voucherNo, modeOfPay,
         data.cheqNo || '', data.cheqDate ? new Date(data.cheqDate) : null, data.bankName || '',
         data.narration || '', username]
      );

      // DR each row (loan, deposit, etc.)
      for (const row of data.rows) {
        if (!row.code || !row.amount) continue;
        await queryRunner.query(
          `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, cheq_no, cheq_amt, cheq_date, bankname, pass_flag, cashier_flag, code, narration, username)
           VALUES ($1, 'DR', $2, $3, 0, $4, $5, $6, 'P', $7, $8, 0, $9, $10, 'N', 'Y', $11, $12, $13)`,
          [nextTransNo++, transDate, data.memberNo, row.accType, row.amount, voucherNo, modeOfPay,
           data.cheqNo || '', data.cheqDate ? new Date(data.cheqDate) : null, data.bankName || '',
           row.code, data.narration || '', username]
        );
      }

      await queryRunner.commitTransaction();
      this.logger.log(`[VoucherPayment] Saved vchr=${voucherNo} member=${data.memberNo} total=${totalAmount} rows=${data.rows.length} → TRANSACTIONS (pass_flag=N)`);

      return { success: true, transNo: nextTransNo - data.rows.length - 1, voucherNo, message: `Voucher ${voucherNo} staged in TRANSACTIONS (pending pass). Total: ${totalAmount}` };
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
      rows: Array<{ code: string; name: string; amount: number; rdSrNo?: string }>;
    },
    username: string = 'system',
  ): Promise<{ success: boolean; transNo: number; voucherNo: string; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`[PaymentVoucher] Saving payment for member ${data.memberNo} rows=${data.rows?.length}`);

      // Get next trans_no and ledgerid
      const maxResult = await queryRunner.query(
        `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
      );
      let nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
      let nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);

      // Generate voucher number if not provided
      let voucherNo = data.voucherNo;
      if (!voucherNo) {
        const vmResult = await queryRunner.query(`SELECT p_vchr_no FROM voucher_master LIMIT 1`);
        const lastNo = vmResult[0]?.p_vchr_no || 'P00000';
        const num = parseInt(lastNo.replace(/\D/g, '')) + 1;
        voucherNo = `P${num.toString().padStart(5, '0')}`;
        await queryRunner.query(`UPDATE voucher_master SET p_vchr_no = $1`, [voucherNo]);
      }

      const transDate = data.transDate ? new Date(data.transDate) : new Date();
      const rows = data.rows || [];

      // Insert one DR ledger row per breakdown row (legacy pattern: each row = separate ledger entry)
      for (const row of rows) {
        if (!row.code || !row.amount) continue;
        await queryRunner.query(
          `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
           VALUES ($1, $2, 'DR', $3, $4, 0, 'BANK', $5, $6, 'P', 'B', 0, $7, $8, $9)`,
          [nextTransNo++, transDate, row.code, data.memberNo, row.amount, voucherNo, data.narration || row.name || '', username, nextLedgerId++]
        );
      }

      await queryRunner.commitTransaction();
      const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
      this.logger.log(`[PaymentVoucher] Saved vchr=${voucherNo} member=${data.memberNo} total=${total} rows=${rows.length}`);

      return { success: true, transNo: nextTransNo - rows.length, voucherNo, message: `Payment voucher ${voucherNo} saved. Total: ${total}` };
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
      await queryRunner.query(
        `INSERT INTO loan_master (mbno, loantype, loancaseno, loan_amt, payment_date, rate, no_of_instal, instal_amt, balance, openbalance, purpose, intt_amount, penalrate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, 0, $11)`,
        [
          data.memberNo, data.loanType, loanCaseNo, data.loanAmount,
          payDate, data.rate, data.noOfInstal, data.instalAmt,
          data.loanAmount, // balance = loan amount initially
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

      await queryRunner.commitTransaction();
      this.logger.log(`[FdRdSbEntry] Saved trans_no=${nextTransNo} acc_type=${accType} code=${code} member=${data.memberNo}`);

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

  async saveHeadMaster(data: any): Promise<{ success: boolean; message: string }> {
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

      RULE_LOAN_MT_MAX_AMT: d.mlnmaxloanamt,
      RULE_LOAN_MT_RATE: d.mlnrate,
      RULE_LOAN_MT_INSTALLMENTS: d.mlnmaxnoinst,
      RULE_LOAN_MT_GUARANTORS: d.mlnnogr,

      RULE_LOAN_EMG_MAX_AMT: d.elnmaxloanamt,
      RULE_LOAN_EMG_RATE: d.elnrate,
      RULE_LOAN_EMG_INSTALLMENTS: d.elnmaxnoinst,
      RULE_LOAN_EMG_GUARANTORS: d.elnnogr,

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

      RULE_FUND_INT_RATE: 0,
      RULE_DIVIDEND_PCT: 0,
      RULE_GRP_INSURANCE_AMT: 0,
      RULE_CD_INTEREST_CHART: '[]',
    };
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
          elnmaxloanamt, elnrate, elnmaxnoinst, elnnogr,
          alnmaxloanamt, alnrate, alnmaxnoinst, alnnogr,
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
          $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24, $25, $26,
          $27, $28, $29,
          $30, $31, $32,
          $33, $34, $35,
          $36, $37, $38
        )`,
        [
          data.RULE_LOAN_R_MAX_AMT || 0, data.RULE_LOAN_R_RATE || 0, data.RULE_PENAL_RATE || 0, data.RULE_LOAN_R_INSTALLMENTS || 0, data.RULE_LOAN_R_GUARANTORS || 0,
          data.RULE_LOAN_EMG_MAX_AMT || 0, data.RULE_LOAN_EMG_RATE || 0, data.RULE_LOAN_EMG_INSTALLMENTS || 0, data.RULE_LOAN_EMG_GUARANTORS || 0,
          data.RULE_LOAN_LT_MAX_AMT || 0, data.RULE_LOAN_LT_RATE || 0, data.RULE_LOAN_LT_INSTALLMENTS || 0, data.RULE_LOAN_LT_GUARANTORS || 0,
          data.RULE_LOAN_MT_MAX_AMT || 0, data.RULE_LOAN_MT_RATE || 0, data.RULE_LOAN_MT_INSTALLMENTS || 0, data.RULE_LOAN_MT_GUARANTORS || 0,
          data.RULE_LOAN_DEP_MAX_AMT || 0, data.RULE_LOAN_DEP_RATE || 0, data.RULE_LOAN_DEP_INSTALLMENTS || 0, data.RULE_LOAN_DEP_GUARANTORS || 0,
          data.RULE_MEMBER_MIN_TENURE_MONTHS || 0, data.RULE_SHARE_MIN_AMT || 0, data.RULE_SHARE_MAX_AMT || 0, data.RULE_CD_MIN_AMT || 0, data.RULE_CD_MAX_AMT || 0,
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
}
