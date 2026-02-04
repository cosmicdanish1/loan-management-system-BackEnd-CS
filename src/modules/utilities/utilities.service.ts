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
        const query = `
          SELECT 
            "accountNumber",
            "memberId",
            "monthlyInstallment",
            "interestRate",
            "startDate",
            "maturityDate",
            "tenureMonths",
            "maturityAmount",
            "totalDeposited",
            "installmentsPaid",
            "status"
          FROM recurring_deposits 
          WHERE "memberId" = $1 
          AND ("status" = 'ACTIVE' OR "status" IS NULL)
          ORDER BY "startDate" DESC
        `;

        const result = await this.dataSource.query(query, [parseInt(memberNo)]);
        this.logger.log(`Found ${result.length} RD accounts for member ${memberNo}`);
        return result;

      } else if (type === 'FD') {
        const query = `
          SELECT 
            "accountNumber",
            "memberId",
            "principalAmount" as "depositAmount",
            "interestRate",
            "depositDate" as "startDate",
            "maturityDate",
            "tenureMonths",
            "maturityAmount",
            "status"
          FROM fixed_deposits 
          WHERE "memberId" = $1 
          AND ("status" = 'ACTIVE' OR "status" IS NULL)
          ORDER BY "depositDate" DESC
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
}
